/**
 * Pkg1 状況ふりわけ + pdf_only の分岐テスト (本物モデル・v1.2.1)。
 *
 *   identified    原因特定済み      → 正規見積ルート (部位 Carousel)
 *   comprehensive 包括メンテしたい  → 包括メンテゲート (4 メニュー carousel)・v1.6
 *   unknown       原因がわからない  → お悩み自由文マッチング入力・v1.6
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

/**
 * 包括メンテゲートの最小 mock: maintenance_menus 1 件 + 対応 labor_master 1 件を返す。
 * GET の URL に含まれるテーブル名で振り分ける。
 */
function mockOverhaulMenus() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    if (method === 'GET' && url.includes('/maintenance_menus')) {
      return new Response(
        JSON.stringify([
          {
            labor_master_id: 'lm-oh-premium',
            duration_days_min: 14,
            duration_days_max: 20,
            detailed_description: '全バラシのコースです。',
            hero_image_url: null,
            sort_order: 0,
          },
        ]),
        { status: 200 },
      );
    }
    if (method === 'GET' && url.includes('/labor_master')) {
      return new Response(
        JSON.stringify([
          {
            id: 'lm-oh-premium',
            code: 'oh-premium',
            category: 'オーバーホール',
            name: 'オーバーホール プレミアム',
            price: 80000,
            price_max: null,
            price_open_ended: false,
            notes: null,
            tags: ['オーバーホール'],
            description: '全バラシ',
          },
        ]),
        { status: 200 },
      );
    }
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

  it('「原因特定済み」 (identified) は経路 B の部位選択 (LH 準拠 Flex 縦リスト) に進む', async () => {
    mockSupabaseFetch();
    const captured: unknown[][] = [];
    const handled = await handlePkg1Postback(
      'action=pkg1_dispatch&value=identified',
      fakeContext(captured),
    );
    expect(handled).toBe(true);
    const s = lastReply(captured);
    expect(s).toContain('action=pkg1_region&value=brake');
    // LH 準拠 Flex 縦リスト (Carousel テンプレートに退化していないこと)。
    expect(s).toContain('"type":"flex"');
    expect(s).not.toContain('carousel');
    expect(s).not.toContain('現物確認が必要');
  });

  it('「包括メンテしたい」 (comprehensive) は包括メンテゲート (4 メニュー carousel) を出す (v1.6)', async () => {
    mockOverhaulMenus();
    const captured: unknown[][] = [];
    await handlePkg1Postback('action=pkg1_dispatch&value=comprehensive', fakeContext(captured));
    const s = lastReply(captured);
    // 初期メッセージ + carousel + entry actions のいずれかが含まれる。
    expect(s).toContain('オーバーホール プレミアム');
    expect(s).toContain('action=pkg1_overhaul&value=picker');
    expect(s).toContain('action=pkg1_overhaul&value=matrix');
    // 旧スタッフ即送り文言には倒れない。
    expect(s).not.toContain('現物確認が必要');
  });

  it('「包括メンテしたい」でメニュー未投入なら お悩みフローへフォールバック (v1.6)', async () => {
    mockSupabaseFetch(); // maintenance_menus / labor_master とも [] → メニュー 0 件
    const captured: unknown[][] = [];
    await handlePkg1Postback('action=pkg1_dispatch&value=comprehensive', fakeContext(captured));
    const s = lastReply(captured);
    expect(s).toContain('どのようなことでお困りですか');
  });

  it('「原因がわからない」 (unknown) は お悩み自由文入力を出す (v1.6)', async () => {
    mockSupabaseFetch();
    const captured: unknown[][] = [];
    await handlePkg1Postback('action=pkg1_dispatch&value=unknown', fakeContext(captured));
    const s = lastReply(captured);
    expect(s).toContain('どのようなことでお困りですか');
    // 旧スタッフ即送り文言には倒れない。
    expect(s).not.toContain('現物確認が必要');
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
