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
