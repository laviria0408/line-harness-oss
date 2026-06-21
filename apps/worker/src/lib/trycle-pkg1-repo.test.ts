import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  findLaborByCode,
  buildLineItemFromPending,
  resetLaborCache,
  saveQuote,
} from './trycle-pkg1-repo.js';
import { findRegionByValue } from '../data/pkg1-regions.js';
import { buildQuote, makeLineItem } from './quote.js';
import type { TrycleRepoEnv } from './trycle-repo.js';

function env(): TrycleRepoEnv {
  return {
    SUPABASE_URL: 'https://sb.example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
    TRYCLE_TENANT_ID: 't-1',
  } as TrycleRepoEnv;
}

function laborRow(over: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    code: 'brake-adjust-both',
    category: 'brake',
    name: 'ブレーキ調整',
    price: 3000,
    price_open_ended: false,
    notes: null,
    ...over,
  };
}

describe('findLaborByCode (5 分 cache)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetLaborCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('resolves a labor row by code and caches subsequent lookups', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify([laborRow()]), { status: 200 }));
    const a = await findLaborByCode(env(), 'brake-adjust-both');
    const b = await findLaborByCode(env(), 'brake-adjust-both');
    expect(a?.price).toBe(3000);
    expect(b?.price).toBe(3000);
    // 1 fetch only (second is cache hit)
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns null for an unknown code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([laborRow()]), { status: 200 }),
    );
    expect(await findLaborByCode(env(), 'no-such-code')).toBeNull();
  });
});

describe('buildLineItemFromPending (本物 sample 解決)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetLaborCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('resolves a variant sample, applies the surcharge and 内装 label', async () => {
    // ステム交換 → 内装（油圧）= stem-internal + surcharge ¥11,000
    const region = findRegionByValue('cockpit-head-fork')!;
    const symptomIndex = region.symptoms!.findIndex((s) => s.label === 'ステム交換');
    const variantIndex = region
      .symptoms![symptomIndex].variants!.findIndex((v) => v.label === '内装（油圧）');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([laborRow({ code: 'stem-internal', name: 'ステム交換', price: 5000 })]),
        { status: 200 },
      ),
    );
    const item = await buildLineItemFromPending(env(), {
      regionValue: 'cockpit-head-fork',
      symptomIndex,
      variantIndex,
    });
    expect(item).not.toBeNull();
    expect(item!.unitPrice).toBe(16000); // 5000 + 11000 surcharge
    expect(item!.name).toContain('内装（油圧）');
    expect(item!.notes).toContain('油圧加算');
  });

  it('appends 〜 for price_open_ended labor', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([laborRow({ code: 'chain-swap', name: 'チェーン交換', price_open_ended: true })]),
        { status: 200 },
      ),
    );
    const region = findRegionByValue('drivetrain')!;
    const symptomIndex = region.symptoms!.findIndex((s) => s.label === 'チェーン交換');
    const item = await buildLineItemFromPending(env(), {
      regionValue: 'drivetrain',
      symptomIndex,
    });
    expect(item!.name).toContain('〜');
  });

  it('returns null when sample is null (その他)', async () => {
    const region = findRegionByValue('drivetrain')!;
    const otherIndex = region.symptoms!.findIndex((s) => s.label === 'その他');
    const item = await buildLineItemFromPending(env(), {
      regionValue: 'drivetrain',
      symptomIndex: otherIndex,
    });
    expect(item).toBeNull();
  });
});

describe('saveQuote (cases + quotes + quote_versions・v1.2.1)', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('inserts cases → quotes → quote_versions and links current_version_id', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method as string) ?? 'GET';
      calls.push({ url, method, body: init?.body as string | undefined });
      if (url.includes('/tenant_fy_counters') && method === 'GET') {
        return new Response('[]', { status: 200 });
      }
      if (url.includes('/cases') && method === 'POST') {
        return new Response(JSON.stringify([{ id: 'case-1' }]), { status: 201 });
      }
      if (url.includes('/quotes') && method === 'POST') {
        return new Response(JSON.stringify([{ id: 'quote-1' }]), { status: 201 });
      }
      if (url.includes('/quote_versions') && method === 'POST') {
        return new Response(JSON.stringify([{ id: 'qv-1' }]), { status: 201 });
      }
      return new Response(null, { status: 201 });
    });

    const quote = buildQuote([makeLineItem({ name: 'ブレーキ調整', unitPrice: 3000, qty: 1 })]);
    const saved = await saveQuote(env(), {
      lineUserId: 'U1',
      customerId: null,
      storeId: 's1',
      storeCode: 'Y',
      statusId: 'st-1',
      quote,
      caseLabel: 'pdf_only',
      visitScheduledAt: null,
      chatSummary: 'x',
    });
    expect(saved.caseId).toBe('case-1');
    expect(saved.quoteId).toBe('quote-1');
    expect(saved.quoteVersionId).toBe('qv-1');
    expect(saved.quoteNo).toMatch(/^Q-Y-/);
    // cases / quotes / quote_versions all inserted
    expect(calls.some((c) => c.url.includes('/cases') && c.method === 'POST')).toBe(true);
    expect(calls.some((c) => c.url.includes('/quotes') && c.method === 'POST')).toBe(true);
    expect(calls.some((c) => c.url.includes('/quote_versions') && c.method === 'POST')).toBe(true);
    // quote_versions payload carries tax/total from the quote
    const qvCall = calls.find((c) => c.url.includes('/quote_versions') && c.method === 'POST');
    const qvBody = JSON.parse(qvCall!.body as string)[0];
    expect(qvBody.tax).toBe(quote.tax);
    expect(qvBody.total).toBe(quote.total);
  });
});
