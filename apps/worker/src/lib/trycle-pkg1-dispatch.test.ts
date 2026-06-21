/**
 * Pkg1 状況ふりわけ + pdf_only の分岐テスト (本物モデル・v1.2.1)。
 *
 *   identified    原因特定済み      → 正規見積ルート (部位 Carousel)
 *   comprehensive 包括メンテしたい  → スタッフ相談誘導 (現物確認文言・経路 B に進めない)
 *   unknown       原因がわからない  → スタッフ相談誘導
 *   pdf_only      → 【v1.2.1】cases + quote_versions に保存して PDF 発行
 *
 * Supabase は globalThis.fetch を spy して制御し、LineClient は reply を捕捉する。
 * postback 命名は本物 `action=pkg1_X&value=Y` (v1.2.1)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handlePkg1Postback, type Pkg1Context } from './trycle-pkg1.js';
import { resetLaborCache } from './trycle-pkg1-repo.js';
import type { Env } from '../index.js';

function bindings(): Env['Bindings'] {
  return {
    SUPABASE_URL: 'https://sb.example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
    TRYCLE_TENANT_ID: 't-1',
    // GMAIL_NOTIFICATION_TO / GAS_WEB_APP_URL 未設定 = notifyStaff/PDF は no-op。
  } as Env['Bindings'];
}

/** 多くの SELECT は [] を返す軽量 mock (dispatch 分岐の確認用)。 */
function mockSupabaseFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') return new Response('[]', { status: 200 });
    return new Response(null, { status: 204 });
  });
}

function fakeContext(captured: unknown[][]): Pkg1Context {
  return {
    replyToken: 'rt-1',
    lineUserId: 'U-test',
    lineClient: {
      replyMessage: async (_token: string, messages: unknown[]) => {
        captured.push(messages);
      },
    } as unknown as Pkg1Context['lineClient'],
    env: bindings(),
  };
}

function lastReply(captured: unknown[][]): string {
  return JSON.stringify(captured.at(-1) ?? []);
}

describe('dispatch 3 択 (REQ-PKG1-002・本物 onDispatch 準拠・v1.2.1 命名)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetLaborCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('「原因特定済み」 (identified) は経路 B の部位 Carousel に進む', async () => {
    mockSupabaseFetch();
    const captured: unknown[][] = [];
    const handled = await handlePkg1Postback(
      'action=pkg1_dispatch&value=identified',
      fakeContext(captured),
    );
    expect(handled).toBe(true);
    const s = lastReply(captured);
    expect(s).toContain('action=pkg1_region&value=brake');
    expect(s).toContain('carousel');
    expect(s).not.toContain('現物確認が必要');
  });

  it('「包括メンテしたい」 (comprehensive) はスタッフ相談誘導 (経路 B に進めない)', async () => {
    mockSupabaseFetch();
    const captured: unknown[][] = [];
    await handlePkg1Postback('action=pkg1_dispatch&value=comprehensive', fakeContext(captured));
    const s = lastReply(captured);
    expect(s).toContain('包括メンテしたい');
    expect(s).toContain('現物確認が必要');
    expect(s).not.toContain('action=pkg1_region');
  });

  it('「原因がわからない」 (unknown) はスタッフ相談誘導', async () => {
    mockSupabaseFetch();
    const captured: unknown[][] = [];
    await handlePkg1Postback('action=pkg1_dispatch&value=unknown', fakeContext(captured));
    const s = lastReply(captured);
    expect(s).toContain('原因がわからない');
    expect(s).toContain('現物確認が必要');
  });

  it('入口タップ (pkg1_start) は状況ふりわけ 3 択を出す', async () => {
    mockSupabaseFetch();
    const captured: unknown[][] = [];
    await handlePkg1Postback('pkg1_start', fakeContext(captured));
    const s = lastReply(captured);
    expect(s).toContain('action=pkg1_dispatch&value=identified');
    expect(s).toContain('action=pkg1_dispatch&value=comprehensive');
    expect(s).toContain('action=pkg1_dispatch&value=unknown');
  });
});

/**
 * pdf_only 経路の入力: cart を 1 件持つ bot_sessions を返し、cases/quote_versions の
 * insert が走る (v1.2.1 §7 #3) ことを確かめる mock。
 */
function mockSupabaseWithCart(casePosts: string[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.includes('/cases')) {
      casePosts.push(url);
      return new Response('[{"id":"case-1"}]', { status: 201 });
    }
    if (method === 'POST' && (url.includes('/quotes') || url.includes('/quote_versions'))) {
      return new Response('[{"id":"q-1"}]', { status: 201 });
    }
    if (method === 'GET' && url.includes('bot_sessions')) {
      return new Response(
        JSON.stringify([
          {
            state: {
              step: 'awaiting_confirm',
              cart: [
                { name: 'ブレーキ調整（両側）', unitPrice: 3000, unitPriceMax: null, qty: 1, amount: 3000, amountMax: 3000 },
              ],
            },
            updated_at: new Date().toISOString(),
          },
        ]),
        { status: 200 },
      );
    }
    if (method === 'GET' && url.includes('case_statuses')) {
      return new Response(JSON.stringify([{ id: 'st1', key: 'new', label: '新規', sort_order: 0 }]), { status: 200 });
    }
    if (method === 'GET' && url.includes('/stores')) {
      return new Response(JSON.stringify([{ id: 's1', code: 'Y' }]), { status: 200 });
    }
    if (method === 'GET' && url.includes('tenant_fy_counters')) {
      return new Response('[]', { status: 200 });
    }
    if (method === 'GET') return new Response('[]', { status: 200 });
    return new Response(null, { status: 204 });
  });
}

describe('pkg1_pdf_only (経路 D-1・v1.2.1: cases + quote_versions 保存)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetLaborCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('cases を作成して PDF 発行の完了文言を返す (連絡先・同意書スキップ)', async () => {
    const casePosts: string[] = [];
    mockSupabaseWithCart(casePosts);
    const captured: unknown[][] = [];
    const handled = await handlePkg1Postback('action=pkg1_confirm&value=pdf_only', fakeContext(captured));
    expect(handled).toBe(true);
    const s = lastReply(captured);
    expect(s).toContain('またのお問い合わせ');
    // v1.2.1: cases を保存する (旧「作らない」を上書き)。
    expect(casePosts.length).toBeGreaterThan(0);
    // 同意書ゲート・来店日選択には行かない。
    expect(s).not.toContain('同意書');
  });

  it('cart が空なら案内を出す', async () => {
    mockSupabaseFetch(); // bot_sessions GET は [] (空)
    const captured: unknown[][] = [];
    await handlePkg1Postback('action=pkg1_confirm&value=pdf_only', fakeContext(captured));
    expect(lastReply(captured)).toContain('整備メニューを先にお選びください');
  });
});
