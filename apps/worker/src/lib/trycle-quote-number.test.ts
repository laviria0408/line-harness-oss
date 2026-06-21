import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fiscalYearFromDate,
  jstTimestamp,
  formatQuoteNo,
  pad6,
  nextSeqNo,
  issueQuoteNo,
} from './trycle-quote-number.js';
import type { TrycleRepoEnv } from './trycle-repo.js';

function env(): TrycleRepoEnv {
  return {
    SUPABASE_URL: 'https://sb.example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
    TRYCLE_TENANT_ID: 't-1',
  } as TrycleRepoEnv;
}

describe('fiscalYearFromDate (4月始まり)', () => {
  it('Jan/2026 → FY2025', () => {
    expect(fiscalYearFromDate(new Date('2026-01-15T00:00:00+09:00'))).toBe(2025);
  });
  it('Apr/2026 → FY2026', () => {
    expect(fiscalYearFromDate(new Date('2026-04-01T00:00:00+09:00'))).toBe(2026);
  });
});

describe('jstTimestamp / pad6 / formatQuoteNo', () => {
  it('builds the Q-{code}-{ts}-{seq}-v{n} format', () => {
    expect(pad6(42)).toBe('000042');
    const ts = jstTimestamp(new Date('2026-06-21T13:05:09+09:00'));
    expect(ts).toBe('20260621130509');
    expect(formatQuoteNo({ storeCode: 'Y', timestamp: ts, seqNo: 7, version: 1 })).toBe(
      'Q-Y-20260621130509-000007-v1',
    );
  });
});

describe('nextSeqNo (read-modify-write)', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('returns last_seq + 1 when a counter row exists', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify([{ last_seq: 4 }]), { status: 200 })) // SELECT
      .mockResolvedValueOnce(new Response(null, { status: 201 })); // UPSERT
    const seq = await nextSeqNo(env(), { storeId: 's1', fyYear: 2026, quoteType: 'estimate' });
    expect(seq).toBe(5);
    // 2 calls: select + upsert
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('returns 1 when no counter row exists', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    const seq = await nextSeqNo(env(), { storeId: 's1', fyYear: 2026, quoteType: 'estimate' });
    expect(seq).toBe(1);
  });
});

describe('issueQuoteNo', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('issues a v1 quote_no using the counter', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify([{ last_seq: 0 }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    const r = await issueQuoteNo(env(), {
      storeId: 's1',
      storeCode: 'Y',
      quoteType: 'estimate',
      now: new Date('2026-06-21T13:00:00+09:00'),
    });
    expect(r.version).toBe(1);
    expect(r.seqNo).toBe(1);
    expect(r.fyYear).toBe(2026);
    expect(r.quoteNo).toMatch(/^Q-Y-2026\d{10}-000001-v1$/);
  });
});
