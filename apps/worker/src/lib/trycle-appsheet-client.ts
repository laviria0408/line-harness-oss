/**
 * AppSheet REST API client (Phase B-6).
 *
 * Ported from `trycle-line-harness/src/lib/appsheet-client.ts`. Env vars are
 * now passed via Hono Env binding instead of process.env. Behavior and column
 * names mirror the Vercel-era version 1:1 so the AppSheet schema (set up by
 * 田渕様) does not need to be re-mapped.
 *
 * AppSheet acts as the canonical customer DB and case-history sink for the
 * shop's existing operations. The bot writes into AppSheet via these helpers.
 *
 * env vars (set via `wrangler secret put`):
 *   APPSHEET_APP_ID         AppSheet app ID
 *   APPSHEET_API_KEY        AppSheet API key
 *   APPSHEET_CUSTOMER_TABLE customer table name (e.g. 'Customers' / '顧客マスタ')
 *   APPSHEET_CASE_TABLE     (optional) case-history table name
 *
 * When env is missing, every call returns `{ ok: false, error: "... not configured" }`
 * — graceful degradation so the user-facing flow is not broken.
 */

import type { Env } from '../index.js';

export type ShopId = 'yano' | 'miyagase';

export interface AppSheetCustomer {
  lineUserId?: string;
  name?: string;
  phone?: string;
  email?: string;
  preferredShop?: ShopId;
  consentedAt?: string;
  firstVisitAt?: string;
  lastVisitAt?: string;
  visitCount?: number;
  tags?: string[];
  _rowId?: string;
}

interface AppSheetResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

const APPSHEET_API_BASE = 'https://api.appsheet.com/api/v2';
const SHOP_NAMES: Record<ShopId, string> = {
  yano: '矢野口本店',
  miyagase: '宮ヶ瀬店',
};

function authHeaders(env: Env['Bindings']): Record<string, string> {
  if (!env.APPSHEET_API_KEY) {
    throw new Error('APPSHEET_API_KEY not configured');
  }
  return {
    ApplicationAccessKey: env.APPSHEET_API_KEY,
    'Content-Type': 'application/json',
  };
}

interface AppSheetCustomerCtx {
  ok: true;
  appId: string;
  table: string;
}
interface AppSheetMissingCtx {
  ok: false;
  reason: string;
}

function customerCtx(
  env: Env['Bindings'],
): AppSheetCustomerCtx | AppSheetMissingCtx {
  if (!env.APPSHEET_APP_ID) {
    return { ok: false, reason: 'APPSHEET_APP_ID not configured' };
  }
  if (!env.APPSHEET_API_KEY) {
    return { ok: false, reason: 'APPSHEET_API_KEY not configured' };
  }
  if (!env.APPSHEET_CUSTOMER_TABLE) {
    return { ok: false, reason: 'APPSHEET_CUSTOMER_TABLE not configured' };
  }
  return { ok: true, appId: env.APPSHEET_APP_ID, table: env.APPSHEET_CUSTOMER_TABLE };
}

export async function findCustomerByLineUserId(
  env: Env['Bindings'],
  lineUserId: string,
): Promise<AppSheetResponse<AppSheetCustomer | null>> {
  const ctx = customerCtx(env);
  if (!ctx.ok) return { ok: false, error: ctx.reason };
  try {
    const res = await fetch(
      `${APPSHEET_API_BASE}/apps/${ctx.appId}/tables/${encodeURIComponent(ctx.table)}/Action`,
      {
        method: 'POST',
        headers: authHeaders(env),
        body: JSON.stringify({
          Action: 'Find',
          Properties: {
            Locale: 'ja-JP',
            Selector: `Filter(${ctx.table}, [LINE userId] = "${lineUserId}")`,
          },
          Rows: [],
        }),
      },
    );
    if (!res.ok) return { ok: false, error: `AppSheet ${res.status}` };
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows) || rows.length === 0) return { ok: true, data: null };
    return { ok: true, data: rowToCustomer(rows[0] as Record<string, unknown>) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function upsertAppSheetCustomer(
  env: Env['Bindings'],
  customer: AppSheetCustomer,
): Promise<AppSheetResponse<{ rowId: string }>> {
  const ctx = customerCtx(env);
  if (!ctx.ok) return { ok: false, error: ctx.reason };
  const action = customer._rowId ? 'Edit' : 'Add';
  const row = customerToRow(customer);
  try {
    const res = await fetch(
      `${APPSHEET_API_BASE}/apps/${ctx.appId}/tables/${encodeURIComponent(ctx.table)}/Action`,
      {
        method: 'POST',
        headers: authHeaders(env),
        body: JSON.stringify({
          Action: action,
          Properties: { Locale: 'ja-JP' },
          Rows: [row],
        }),
      },
    );
    if (!res.ok) return { ok: false, error: `AppSheet ${res.status}` };
    const result = (await res.json()) as { Rows?: Array<{ _RowNumber?: string }> };
    const rowId = customer._rowId ?? result.Rows?.[0]?._RowNumber ?? '';
    return { ok: true, data: { rowId } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function appendAppSheetCase(
  env: Env['Bindings'],
  rec: {
    lineUserId: string;
    kind: string;
    shop: ShopId;
    quoteAmount?: number;
    quoteNo?: string;
    pdfUrl?: string;
    ts: string;
  },
): Promise<AppSheetResponse> {
  if (!env.APPSHEET_CASE_TABLE) {
    return { ok: false, error: 'APPSHEET_CASE_TABLE not configured' };
  }
  const ctx = customerCtx(env);
  if (!ctx.ok) return { ok: false, error: ctx.reason };
  try {
    const res = await fetch(
      `${APPSHEET_API_BASE}/apps/${ctx.appId}/tables/${encodeURIComponent(env.APPSHEET_CASE_TABLE)}/Action`,
      {
        method: 'POST',
        headers: authHeaders(env),
        body: JSON.stringify({
          Action: 'Add',
          Properties: { Locale: 'ja-JP' },
          Rows: [
            {
              'LINE userId': rec.lineUserId,
              種別: rec.kind,
              店舗: SHOP_NAMES[rec.shop],
              ...(rec.quoteAmount !== undefined ? { 合計: rec.quoteAmount } : {}),
              ...(rec.quoteNo ? { 見積No: rec.quoteNo } : {}),
              ...(rec.pdfUrl ? { PDFリンク: rec.pdfUrl } : {}),
              受付日時: rec.ts,
            },
          ],
        }),
      },
    );
    if (!res.ok) return { ok: false, error: `AppSheet ${res.status}` };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Row ↔ AppSheetCustomer mapping. Column names mirror the Vercel-era client
// 1:1 so the existing AppSheet schema does not need to be re-mapped.

function rowToCustomer(row: Record<string, unknown>): AppSheetCustomer {
  return {
    lineUserId: stringOrUndefined(row['LINE userId']),
    name: stringOrUndefined(row['氏名']),
    phone: stringOrUndefined(row['電話']),
    email: stringOrUndefined(row['メール']),
    preferredShop: parseShop(row['担当店舗']),
    consentedAt: stringOrUndefined(row['同意取得日']),
    firstVisitAt: stringOrUndefined(row['初回来店日']),
    lastVisitAt: stringOrUndefined(row['最終来店日']),
    visitCount: typeof row['来店回数'] === 'number' ? (row['来店回数'] as number) : undefined,
    tags: typeof row['案件タグ'] === 'string'
      ? (row['案件タグ'] as string)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      : [],
    _rowId: stringOrUndefined(row['_RowNumber']),
  };
}

function customerToRow(c: AppSheetCustomer): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (c.lineUserId) row['LINE userId'] = c.lineUserId;
  if (c.name) row['氏名'] = c.name;
  if (c.phone) row['電話'] = c.phone;
  if (c.email) row['メール'] = c.email;
  if (c.preferredShop) row['担当店舗'] = SHOP_NAMES[c.preferredShop];
  if (c.consentedAt) row['同意取得日'] = c.consentedAt;
  if (c.firstVisitAt) row['初回来店日'] = c.firstVisitAt;
  if (c.lastVisitAt) row['最終来店日'] = c.lastVisitAt;
  if (c.visitCount !== undefined) row['来店回数'] = c.visitCount;
  if (c.tags && c.tags.length > 0) row['案件タグ'] = c.tags.join(', ');
  if (c._rowId) row['_RowNumber'] = c._rowId;
  return row;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseShop(value: unknown): ShopId | undefined {
  if (value === SHOP_NAMES.yano) return 'yano';
  if (value === SHOP_NAMES.miyagase) return 'miyagase';
  return undefined;
}
