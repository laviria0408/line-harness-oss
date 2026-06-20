import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  findCustomerByLineUserId,
  upsertAppSheetCustomer,
  appendAppSheetCase,
} from './trycle-appsheet-client.js';
import type { Env } from '../index.js';

type Bindings = Env['Bindings'];

function makeEnv(overrides: Partial<Bindings> = {}): Bindings {
  return {
    APPSHEET_APP_ID: 'app-1',
    APPSHEET_API_KEY: 'key-1',
    APPSHEET_CUSTOMER_TABLE: 'Customers',
    APPSHEET_CASE_TABLE: 'Cases',
    ...overrides,
  } as Bindings;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('findCustomerByLineUserId', () => {
  it('returns error when AppSheet env is missing', async () => {
    const env = makeEnv({ APPSHEET_APP_ID: undefined });
    const res = await findCustomerByLineUserId(env, 'Uabc');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/APPSHEET_APP_ID/);
  });

  it('returns null data when AppSheet returns no rows', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    const res = await findCustomerByLineUserId(makeEnv(), 'Uabc');
    expect(res.ok).toBe(true);
    expect(res.data).toBeNull();
  });

  it('maps AppSheet row to AppSheetCustomer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            'LINE userId': 'Uabc',
            氏名: '田渕 太郎',
            電話: '090-0000-0000',
            メール: 't@example.com',
            担当店舗: '矢野口本店',
            同意取得日: '2026-06-01',
            来店回数: 3,
            案件タグ: 'pkg1, vip',
            _RowNumber: '42',
          },
        ]),
        { status: 200 },
      ),
    );
    const res = await findCustomerByLineUserId(makeEnv(), 'Uabc');
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({
      lineUserId: 'Uabc',
      name: '田渕 太郎',
      phone: '090-0000-0000',
      email: 't@example.com',
      preferredShop: 'yano',
      consentedAt: '2026-06-01',
      firstVisitAt: undefined,
      lastVisitAt: undefined,
      visitCount: 3,
      tags: ['pkg1', 'vip'],
      _rowId: '42',
    });
  });

  it('returns error on AppSheet non-OK status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('forbidden', { status: 403 }),
    );
    const res = await findCustomerByLineUserId(makeEnv(), 'Uabc');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/403/);
  });
});

describe('upsertAppSheetCustomer', () => {
  it('uses Action=Add when _rowId is absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ Rows: [{ _RowNumber: '99' }] }), { status: 200 }),
    );
    const res = await upsertAppSheetCustomer(makeEnv(), {
      lineUserId: 'Uabc',
      name: '田渕 太郎',
      preferredShop: 'miyagase',
      tags: ['pkg1'],
    });
    expect(res.ok).toBe(true);
    expect(res.data?.rowId).toBe('99');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.Action).toBe('Add');
    expect(body.Rows[0]['LINE userId']).toBe('Uabc');
    expect(body.Rows[0]['担当店舗']).toBe('宮ヶ瀬店');
    expect(body.Rows[0]['案件タグ']).toBe('pkg1');
  });

  it('uses Action=Edit and preserves rowId when _rowId is set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ Rows: [{}] }), { status: 200 }),
    );
    const res = await upsertAppSheetCustomer(makeEnv(), {
      lineUserId: 'Uabc',
      _rowId: '7',
    });
    expect(res.ok).toBe(true);
    expect(res.data?.rowId).toBe('7');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.Action).toBe('Edit');
  });
});

describe('appendAppSheetCase', () => {
  it('returns error when APPSHEET_CASE_TABLE is missing', async () => {
    const env = makeEnv({ APPSHEET_CASE_TABLE: undefined });
    const res = await appendAppSheetCase(env, {
      lineUserId: 'Uabc',
      kind: '見積',
      shop: 'yano',
      ts: '2026-06-20T10:00:00+09:00',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/APPSHEET_CASE_TABLE/);
  });

  it('POSTs case row to the case table with shop translated to JP name', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const res = await appendAppSheetCase(makeEnv(), {
      lineUserId: 'Uabc',
      kind: '見積',
      shop: 'miyagase',
      quoteAmount: 5500,
      quoteNo: 'Q-25-06-1',
      pdfUrl: 'https://drive/x.pdf',
      ts: '2026-06-20T10:00:00+09:00',
    });
    expect(res.ok).toBe(true);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('/tables/Cases/Action');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.Action).toBe('Add');
    expect(body.Rows[0]).toEqual({
      'LINE userId': 'Uabc',
      種別: '見積',
      店舗: '宮ヶ瀬店',
      合計: 5500,
      見積No: 'Q-25-06-1',
      PDFリンク: 'https://drive/x.pdf',
      受付日時: '2026-06-20T10:00:00+09:00',
    });
  });
});
