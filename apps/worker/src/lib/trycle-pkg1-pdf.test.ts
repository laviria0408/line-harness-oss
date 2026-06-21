import { describe, expect, it, vi, afterEach } from 'vitest';
import { issueEstimatePdf } from './trycle-pkg1-pdf.js';
import { buildQuote, makeLineItem } from './quote.js';
import type { Env } from '../index.js';

type Bindings = Env['Bindings'];

function makeEnv(overrides: Partial<Bindings> = {}): Bindings {
  return { GAS_WEB_APP_URL: 'https://script.example.com/exec', ...overrides } as Bindings;
}

const sampleQuote = buildQuote([
  makeLineItem({ name: 'パンク修理', unitPrice: 1650, qty: 1 }),
]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('issueEstimatePdf', () => {
  it('sends source-of-truth camelCase payload (userId/contact/lineItems)', async () => {
    let captured: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({ ok: true, data: { quoteNo: 'Q-1', driveUrl: 'https://drive/x', estimateAmount: 1815 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    await issueEstimatePdf(makeEnv(), {
      quote: sampleQuote,
      customerName: '田中',
      storeName: '矢野口本店',
      quoteNo: 'Q-1',
      lineUserId: 'U_TEST',
    });

    expect(captured.type).toBe('estimate_pdf');
    const payload = captured.payload as Record<string, unknown>;
    // GAS が読む camelCase envelope であること。
    expect(payload.userId).toBe('U_TEST');
    expect((payload.contact as { name: string }).name).toBe('田中');
    const items = payload.lineItems as Array<Record<string, unknown>>;
    expect(items[0].name).toBe('パンク修理');
    expect(items[0].unitPrice).toBe(1650);
    expect(items[0].amount).toBe(1650);
    expect(items[0].qty).toBe(1);
    // 旧バグの snake_case キーが残っていないこと。
    expect(payload.line_items).toBeUndefined();
    expect(payload.customer_name).toBeUndefined();
  });

  it('reads pdf URL from data.driveUrl (GAS handleEstimatePdf 戻り値)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ ok: true, data: { quoteNo: 'Q-2', driveUrl: 'https://drive.google.com/file/d/abc/view', estimateAmount: 1815 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const res = await issueEstimatePdf(makeEnv(), {
      quote: sampleQuote,
      customerName: null,
      storeName: null,
      quoteNo: null,
      lineUserId: 'U_TEST',
    });

    expect(res.ok).toBe(true);
    expect(res.pdfUrl).toBe('https://drive.google.com/file/d/abc/view');
  });

  it('returns ok=false when GAS_WEB_APP_URL is not configured', async () => {
    const env = makeEnv({ GAS_WEB_APP_URL: undefined } as Partial<Bindings>);
    const res = await issueEstimatePdf(env, {
      quote: sampleQuote,
      customerName: null,
      storeName: null,
      quoteNo: null,
      lineUserId: 'U_TEST',
    });
    expect(res.ok).toBe(false);
  });
});
