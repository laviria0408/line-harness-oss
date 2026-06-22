/**
 * TRYCLE business endpoints (Phase B-3).
 *
 * Surface-area kept small on purpose: each endpoint returns JSON so the
 * webhook handler / LIFF / external integrators can reach in. The browser-
 * authenticated admin UI uses LINE Harness' standard routes — TRYCLE
 * business goes through here.
 */
import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  findCustomerByLineUserId,
  hasValidMaintenanceConsent,
  listActiveStores,
  findStoreById,
  findLaborByCode,
  getTenantQuoteSettings,
  upsertCustomer,
  upsertConsent,
  MAINTENANCE_CONSENT_SOURCE,
} from '../lib/trycle-repo.js';
import { buildQuote, makeLineItem, formatQuoteText } from '../lib/quote.js';
import {
  parseJstDatetime,
  validateVisitAt,
} from '../lib/trycle-store-hours.js';
import {
  tagFriendByLineUserId,
  TRYCLE_TAG_CONSENT,
  TRYCLE_TAG_QUOTE,
} from '../lib/trycle-tagging.js';

export const trycle = new Hono<Env>();

// ── Healthcheck ─────────────────────────────────────────────────────────────

trycle.get('/api/trycle/health', (c) => {
  return c.json({
    ok: true,
    tenant: c.env.TRYCLE_TENANT_ID ? 'configured' : 'missing',
    supabase: c.env.SUPABASE_URL ? 'configured' : 'missing',
  });
});

// ── Customer lookup ─────────────────────────────────────────────────────────

trycle.get('/api/trycle/customers/by-line-user/:lineUserId', async (c) => {
  const lineUserId = c.req.param('lineUserId');
  try {
    const customer = await findCustomerByLineUserId(c.env, lineUserId);
    return c.json({ ok: true, customer });
  } catch (err) {
    return c.json({ ok: false, error: errorMessage(err) }, 500);
  }
});

// ── Consent ─────────────────────────────────────────────────────────────────

trycle.get('/api/trycle/consents/:lineUserId/valid', async (c) => {
  const lineUserId = c.req.param('lineUserId');
  try {
    const valid = await hasValidMaintenanceConsent(c.env, lineUserId);
    return c.json({ ok: true, valid });
  } catch (err) {
    return c.json({ ok: false, error: errorMessage(err) }, 500);
  }
});

trycle.post('/api/trycle/consents', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid JSON' }, 400);
  }
  const parsed = parseConsentBody(body);
  if (!parsed.ok) {
    return c.json({ ok: false, error: parsed.reason }, 400);
  }
  try {
    await upsertCustomer(c.env, {
      lineUserId: parsed.lineUserId,
      name: parsed.name,
      phone: parsed.phone,
      email: parsed.email,
    });
    await upsertConsent(c.env, {
      lineUserId: parsed.lineUserId,
      source: MAINTENANCE_CONSENT_SOURCE,
      payload: parsed.payload,
    });
    await tagFriendByLineUserId(c.env, parsed.lineUserId, TRYCLE_TAG_CONSENT);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: errorMessage(err) }, 500);
  }
});

interface ConsentBody {
  lineUserId: string;
  name: string;
  phone: string | null;
  email: string | null;
  payload: Record<string, unknown>;
}

function parseConsentBody(
  raw: unknown,
): { ok: true } & ConsentBody | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'body must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  const lineUserId = typeof obj.lineUserId === 'string' ? obj.lineUserId : null;
  if (!lineUserId) {
    return { ok: false, reason: 'lineUserId is required' };
  }
  const name = typeof obj.name === 'string' && obj.name.trim().length > 0
    ? obj.name.trim()
    : '(未登録)';
  return {
    ok: true,
    lineUserId,
    name,
    phone: typeof obj.phone === 'string' ? obj.phone : null,
    email: typeof obj.email === 'string' ? obj.email : null,
    payload: isRecord(obj.payload) ? obj.payload : {},
  };
}

// ── Stores ──────────────────────────────────────────────────────────────────

trycle.get('/api/trycle/stores', async (c) => {
  try {
    const stores = await listActiveStores(c.env);
    return c.json({ ok: true, stores });
  } catch (err) {
    return c.json({ ok: false, error: errorMessage(err) }, 500);
  }
});

trycle.get('/api/trycle/stores/:id', async (c) => {
  try {
    const store = await findStoreById(c.env, c.req.param('id'));
    if (!store) {
      return c.json({ ok: false, error: 'store not found' }, 404);
    }
    return c.json({ ok: true, store });
  } catch (err) {
    return c.json({ ok: false, error: errorMessage(err) }, 500);
  }
});

trycle.post('/api/trycle/stores/:id/validate-visit', async (c) => {
  const storeId = c.req.param('id');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid JSON' }, 400);
  }
  const datetime = isRecord(body) && typeof body.datetime === 'string'
    ? body.datetime
    : null;
  if (!datetime) {
    return c.json({ ok: false, error: 'datetime is required' }, 400);
  }
  const visitAt = parseJstDatetime(datetime);
  if (!visitAt) {
    return c.json({ ok: false, error: 'invalid datetime format' }, 400);
  }
  try {
    const store = await findStoreById(c.env, storeId);
    if (!store) {
      return c.json({ ok: false, error: 'store not found' }, 404);
    }
    const verdict = validateVisitAt(store, visitAt);
    return c.json({ ok: true, verdict });
  } catch (err) {
    return c.json({ ok: false, error: errorMessage(err) }, 500);
  }
});

// ── Quote calculation ───────────────────────────────────────────────────────

/**
 * Calculate a quote from labor codes. Body shape:
 *   { items: [{ laborCode: string, qty?: number }] }
 *
 * Looks each up in labor_master, builds line items, returns the quote object
 * plus a formatted text suitable for direct LINE reply.
 */
trycle.post('/api/trycle/quote', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid JSON' }, 400);
  }
  const parsed = parseQuoteBody(body);
  if (!parsed.ok) {
    return c.json({ ok: false, error: parsed.reason }, 400);
  }

  try {
    const lineItems = [];
    for (const item of parsed.items) {
      const labor = await findLaborByCode(c.env, item.laborCode);
      if (!labor) {
        return c.json(
          { ok: false, error: `unknown laborCode: ${item.laborCode}` },
          400,
        );
      }
      lineItems.push(
        makeLineItem({
          name: labor.name + (labor.price_open_ended ? '〜' : ''),
          unitPrice: labor.price,
          unitPriceMax: null,
          qty: item.qty,
          notes: labor.notes ?? undefined,
        }),
      );
    }
    const quote = buildQuote(lineItems, await getTenantQuoteSettings(c.env));
    if (parsed.lineUserId) {
      await tagFriendByLineUserId(c.env, parsed.lineUserId, TRYCLE_TAG_QUOTE);
    }
    return c.json({ ok: true, quote, text: formatQuoteText(quote) });
  } catch (err) {
    return c.json({ ok: false, error: errorMessage(err) }, 500);
  }
});

interface QuoteItem {
  laborCode: string;
  qty: number;
}

interface ParsedQuoteBody {
  items: QuoteItem[];
  lineUserId: string | null;
}

function parseQuoteBody(
  raw: unknown,
): { ok: true } & ParsedQuoteBody | { ok: false; reason: string } {
  if (!isRecord(raw)) {
    return { ok: false, reason: 'body must be a JSON object' };
  }
  const items = raw.items;
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, reason: 'items must be a non-empty array' };
  }
  const parsed: QuoteItem[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      return { ok: false, reason: 'each item must be an object' };
    }
    if (typeof item.laborCode !== 'string') {
      return { ok: false, reason: 'item.laborCode must be a string' };
    }
    const qty = typeof item.qty === 'number' && Number.isFinite(item.qty)
      ? Math.floor(item.qty)
      : 1;
    if (qty < 1) {
      return { ok: false, reason: 'item.qty must be >= 1' };
    }
    parsed.push({ laborCode: item.laborCode, qty });
  }
  const lineUserId = typeof raw.lineUserId === 'string' && raw.lineUserId.length > 0
    ? raw.lineUserId
    : null;
  return { ok: true, items: parsed, lineUserId };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
