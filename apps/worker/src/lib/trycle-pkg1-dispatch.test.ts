/**
 * Pkg1 状況ふりわけ 3 択の分岐テスト (本物 pkg1-estimate.test.ts の dispatch suite を反映)。
 *
 *   identified    原因特定済み      → 正規見積ルート (カテゴリ Bubble)
 *   comprehensive 包括メンテしたい  → スタッフ相談誘導 (現物確認文言・経路 B に進めない)
 *   unknown       原因がわからない  → スタッフ相談誘導
 *
 * Supabase は globalThis.fetch を spy して制御し (trycle-session.test.ts と同パターン)、
 * LineClient は reply を捕捉するフェイクを渡す。GAS (notifyStaff) は env 未設定で no-op。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handlePkg1Postback, type Pkg1Context } from './trycle-pkg1.js';
import type { Env } from '../index.js';

function bindings(): Env['Bindings'] {
  return {
    SUPABASE_URL: 'https://sb.example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
    TRYCLE_TENANT_ID: 't-1',
    // GMAIL_NOTIFICATION_TO / GAS_WEB_APP_URL は未設定 = notifyStaff は no-op。
  } as Env['Bindings'];
}

/**
 * Supabase fetch をルーティングする mock。
 *   labor_master の SELECT → カテゴリ 2 件を返す (identified が carousel を出せる)。
 *   その他の SELECT → [] / UPSERT / DELETE → 204 相当。
 */
function mockSupabaseFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && url.includes('labor_master')) {
      return new Response(
        JSON.stringify([
          { category: 'brake', sort_order: 0 },
          { category: 'tire', sort_order: 1 },
        ]),
        { status: 200 },
      );
    }
    if (method === 'GET') {
      return new Response('[]', { status: 200 });
    }
    // UPSERT / DELETE / PATCH
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

function lastReply(captured: unknown[][]): unknown[] {
  return captured.at(-1) ?? [];
}

function serialize(messages: unknown[]): string {
  return JSON.stringify(messages);
}

describe('dispatch 3 択 (REQ-PKG1-002・本物 onDispatch 準拠)', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('「原因特定済み」 (identified) は経路 B のカテゴリ Bubble に進む', async () => {
    mockSupabaseFetch();
    const captured: unknown[][] = [];
    const handled = await handlePkg1Postback('pkg1_dispatch_identified', fakeContext(captured));

    expect(handled).toBe(true);
    const s = serialize(lastReply(captured));
    // カテゴリ Bubble (経路 B) が出ていること。
    expect(s).toContain('pkg1_cat_brake');
    expect(s).toContain('整備カテゴリ');
    // スタッフ送り文言は出ていないこと。
    expect(s).not.toContain('現物確認が必要');
  });

  it('「包括メンテしたい」 (comprehensive) はスタッフ相談誘導 (現物確認文言・経路 B に進めない)', async () => {
    mockSupabaseFetch();
    const captured: unknown[][] = [];
    await handlePkg1Postback('pkg1_dispatch_comprehensive', fakeContext(captured));

    const s = serialize(lastReply(captured));
    expect(s).toContain('包括メンテしたい');
    expect(s).toContain('現物確認が必要');
    expect(s).toContain('スタッフにおつなぎします');
    // カテゴリ Bubble (経路 B) には進まないこと。
    expect(s).not.toContain('pkg1_cat_brake');
  });

  it('「原因がわからない」 (unknown) はスタッフ相談誘導', async () => {
    mockSupabaseFetch();
    const captured: unknown[][] = [];
    await handlePkg1Postback('pkg1_dispatch_unknown', fakeContext(captured));

    const s = serialize(lastReply(captured));
    expect(s).toContain('原因がわからない');
    expect(s).toContain('現物確認が必要');
    expect(s).not.toContain('pkg1_cat_brake');
  });

  it('入口タップ (pkg1_start) は状況ふりわけ 3 択 Bubble を出す', async () => {
    mockSupabaseFetch();
    const captured: unknown[][] = [];
    await handlePkg1Postback('pkg1_start', fakeContext(captured));

    const s = serialize(lastReply(captured));
    expect(s).toContain('pkg1_dispatch_identified');
    expect(s).toContain('pkg1_dispatch_comprehensive');
    expect(s).toContain('pkg1_dispatch_unknown');
  });
});

/**
 * cart を 1 件持つ bot_sessions を返す Supabase mock (pdf_only 経路の入力)。
 * cases insert が走らないことを確かめるため、cases への POST を捕捉する。
 */
function mockSupabaseWithCart(casePosts: string[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.includes('/cases')) {
      casePosts.push(url);
      return new Response('[{"id":"case-1"}]', { status: 201 });
    }
    if (method === 'GET' && url.includes('bot_sessions')) {
      return new Response(
        JSON.stringify([
          {
            state: {
              step: 'quoted',
              cart: [
                {
                  labor_id: 'l1', code: 'brake-adjust', name: 'ブレーキ調整',
                  unit_price: 2000, unit_price_max: null, qty: 1,
                  option_ids: [], option_names: [], option_total: 0,
                },
              ],
            },
            updated_at: new Date().toISOString(),
          },
        ]),
        { status: 200 },
      );
    }
    if (method === 'GET') {
      return new Response('[]', { status: 200 });
    }
    return new Response(null, { status: 204 });
  });
}

describe('pkg1_pdf_only (経路 C・本物 finishPdfOnly 準拠・指摘 3)', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('PDF 発行完了の ack を返し、cases は作らない (連絡先・同意書スキップ)', async () => {
    const casePosts: string[] = [];
    mockSupabaseWithCart(casePosts);
    const captured: unknown[][] = [];
    const handled = await handlePkg1Postback('pkg1_pdf_only', fakeContext(captured));

    expect(handled).toBe(true);
    const s = serialize(lastReply(captured));
    expect(s).toContain('お見積書 (PDF) を発行しました');
    // 来店予定 (経路 D) には進まない = cases insert は走らない。
    expect(casePosts.length).toBe(0);
    // 同意書ゲートにも来店日選択にも行かない。
    expect(s).not.toContain('pkg1_visit_day_');
    expect(s).not.toContain('同意書');
  });

  it('cart が空なら「カートが空です」案内を出す', async () => {
    mockSupabaseFetch(); // bot_sessions GET は [] (空) を返す
    const captured: unknown[][] = [];
    await handlePkg1Postback('pkg1_pdf_only', fakeContext(captured));

    const s = serialize(lastReply(captured));
    expect(s).toContain('カートが空です');
  });
});
