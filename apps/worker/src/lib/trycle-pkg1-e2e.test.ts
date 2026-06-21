/**
 * Pkg1 全動線 E2E (postback wiring 監査・本物モデル v1.2.1)。
 *
 * 実機で「動かない選択肢がある」報告を受け、Flex builder が生成する全 postback を
 * 実 dispatcher (handlePkg1Postback) に順に投げて state 遷移を検証する。Supabase は
 * in-memory の stateful mock (bot_sessions を実際に upsert/select/delete・labor_master /
 * stores / case_statuses を返す) で再現し、各ステップが「黙って no-op」しないことを確かめる。
 *
 *   経路 B: dispatch(identified) → region → symptom → variant → qty → cart
 *   経路 C: cart(confirm) → confirm(概算見積)
 *   経路 D-1: confirm(pdf_only) → cases 保存 + 完了文言
 *   経路 D-2: confirm(reserve) → (同意済) → 日時候補 縦リスト → reserve_slot → reserve_confirm(ok)
 *   経路 redo / cart(add) / reserve_confirm(change) も検証。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handlePkg1Postback, type Pkg1Context } from './trycle-pkg1.js';
import { resetLaborCache } from './trycle-pkg1-repo.js';
import { REGIONS } from '../data/pkg1-regions.js';
import type { Env } from '../index.js';

function bindings(): Env['Bindings'] {
  return {
    SUPABASE_URL: 'https://sb.example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
    TRYCLE_TENANT_ID: 't-1',
    LIFF_CONSENT_URL: 'https://liff.example.com/consent',
  } as Env['Bindings'];
}

/**
 * stateful な in-memory Supabase。bot_sessions を kind 別に保持し、labor_master /
 * stores / case_statuses / cases / quotes / quote_versions を返す。これにより
 * postback を順に投げると本物同様に session が遷移する。
 */
interface MockOpts {
  /** hasValidMaintenanceConsent が true を返すか (経路 D-2 の同意ゲート)。 */
  consentValid?: boolean;
}

function buildStatefulSupabase(opts: MockOpts = {}) {
  // kind -> state JSON (bot_sessions の擬似テーブル)。
  const sessions = new Map<string, unknown>();

  function laborRow(code: string) {
    return {
      id: `labor-${code}`,
      code,
      category: 'cat',
      name: `作業:${code}`,
      price: 3000,
      price_open_ended: false,
      notes: null,
    };
  }

  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const u = new URL(url);
    const table = u.pathname.split('/rest/v1/')[1]?.split('?')[0] ?? u.pathname;

    // ── bot_sessions: kind 別 stateful ──
    if (table === 'bot_sessions') {
      const kindParam = u.searchParams.get('kind') ?? '';
      const kind = kindParam.replace(/^eq\./, '');
      if (method === 'GET') {
        const state = sessions.get(kind);
        if (state === undefined) return new Response('[]', { status: 200 });
        return new Response(
          JSON.stringify([{ state, updated_at: new Date().toISOString() }]),
          { status: 200 },
        );
      }
      if (method === 'POST') {
        const body = JSON.parse((init?.body as string) ?? '[]');
        const row = Array.isArray(body) ? body[0] : body;
        sessions.set(row.kind, row.state);
        return new Response('[]', { status: 201 });
      }
      if (method === 'DELETE') {
        sessions.set(kind, undefined as unknown);
        sessions.delete(kind);
        return new Response(null, { status: 204 });
      }
    }

    // ── 顧客同意 (consents・hasValidMaintenanceConsent は consented_at で判定) ──
    if (table === 'consents' && method === 'GET') {
      return new Response(
        opts.consentValid
          ? JSON.stringify([{ consented_at: new Date().toISOString() }])
          : '[]',
        { status: 200 },
      );
    }

    // ── labor_master ──
    if (table === 'labor_master' && method === 'GET') {
      // 全件返す: regions.ts の全 sample をカバー。
      const codes = new Set<string>();
      for (const r of REGIONS) {
        for (const s of r.symptoms ?? []) {
          if (s.sample) codes.add(s.sample);
          for (const v of s.variants ?? []) if (v.sample) codes.add(v.sample);
        }
      }
      return new Response(JSON.stringify([...codes].map(laborRow)), { status: 200 });
    }

    // ── stores (business_hours は全曜日 09:00-19:00・30 分刻み) ──
    if (table === 'stores' && method === 'GET') {
      const hours: [string, string] = ['09:00', '19:00'];
      return new Response(
        JSON.stringify([
          {
            id: 's1',
            code: 'Y',
            name: '矢野口本店',
            reservation_slot_minutes: 30,
            is_active: true,
            business_hours: {
              mon: hours,
              tue: hours,
              wed: hours,
              thu: hours,
              fri: hours,
              sat: hours,
              sun: hours,
            },
          },
        ]),
        { status: 200 },
      );
    }

    // ── case_statuses ──
    if (table === 'case_statuses' && method === 'GET') {
      return new Response(
        JSON.stringify([{ id: 'st1', key: 'new', label: '新規', sort_order: 0 }]),
        { status: 200 },
      );
    }

    // ── customers (resolveCustomerName / findCustomerIdByLineUserId) ──
    if (table === 'customers' && method === 'GET') {
      return new Response('[]', { status: 200 });
    }

    // ── 採番カウンタ ──
    if (table === 'tenant_fy_counters') {
      if (method === 'GET') return new Response('[]', { status: 200 });
      return new Response('[{"id":"c1"}]', { status: 201 });
    }

    // ── cases / quotes / quote_versions (insert) ──
    if (['cases', 'quotes', 'quote_versions'].includes(table)) {
      if (method === 'POST') return new Response('[{"id":"row-1"}]', { status: 201 });
      if (method === 'GET') return new Response('[]', { status: 200 });
      return new Response(null, { status: 204 });
    }

    // default
    if (method === 'GET') return new Response('[]', { status: 200 });
    return new Response(null, { status: 204 });
  });

  return { fetchSpy, sessions };
}

function fakeContext(captured: unknown[][], datetime?: string): Pkg1Context {
  return {
    replyToken: 'rt-1',
    lineUserId: 'U-e2e',
    lineClient: {
      replyMessage: async (_t: string, messages: unknown[]) => {
        captured.push(messages);
      },
      pushMessage: async (_u: string, messages: unknown[]) => {
        captured.push(messages);
      },
    } as unknown as Pkg1Context['lineClient'],
    env: bindings(),
    ...(datetime ? { datetime } : {}),
  };
}

function last(captured: unknown[][]): string {
  return JSON.stringify(captured.at(-1) ?? []);
}

/** brake region の index (postback value は region.value)。 */
const BRAKE = 'brake';

describe('Pkg1 全動線 E2E (postback wiring・経路 B→C→D)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetLaborCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('経路 B: identified→region(brake)→symptom→variant→qty まで各ステップが進む', async () => {
    buildStatefulSupabase();
    const captured: unknown[][] = [];
    const ctx = fakeContext(captured);

    // dispatch → region 一覧
    await handlePkg1Postback('action=pkg1_dispatch&value=identified', ctx);
    expect(last(captured)).toContain('action=pkg1_region&value=brake');

    // region(brake) → symptom 一覧 (brake[0]=ブレーキ調整 は variants 持ち)
    await handlePkg1Postback(`action=pkg1_region&value=${BRAKE}`, ctx);
    expect(last(captured)).toContain('action=pkg1_symptom&value=0');

    // symptom(0=ブレーキ調整) → variant 一覧 (variants 持ち)
    await handlePkg1Postback('action=pkg1_symptom&value=0', ctx);
    expect(last(captured)).toContain('action=pkg1_variant&value=0');

    // variant(0=両側) → ブレーキ調整は qty 無し → 直接 cart decision
    await handlePkg1Postback('action=pkg1_variant&value=0', ctx);
    expect(last(captured)).toContain('action=pkg1_cart&value=confirm');
  });

  it('経路 B: qty 必須作業 (タイヤ→パンク修理 pair) は qty を聞いてから cart へ', async () => {
    buildStatefulSupabase();
    const captured: unknown[][] = [];
    const ctx = fakeContext(captured);

    await handlePkg1Postback('action=pkg1_dispatch&value=identified', ctx);
    await handlePkg1Postback('action=pkg1_region&value=tire', ctx);
    // tire[0] = パンク修理 (sample 直・qty: pair・variants 無し)
    await handlePkg1Postback('action=pkg1_symptom&value=0', ctx);
    expect(last(captured)).toContain('action=pkg1_qty&value=');

    // qty 選択 → cart decision
    await handlePkg1Postback('action=pkg1_qty&value=2', ctx);
    expect(last(captured)).toContain('action=pkg1_cart&value=confirm');
  });

  it('経路 C: cart(confirm) → 概算見積 (pdf_only/reserve/redo の 3 択) を出す', async () => {
    buildStatefulSupabase();
    const captured: unknown[][] = [];
    const ctx = fakeContext(captured);

    await handlePkg1Postback('action=pkg1_dispatch&value=identified', ctx);
    await handlePkg1Postback(`action=pkg1_region&value=${BRAKE}`, ctx);
    await handlePkg1Postback('action=pkg1_symptom&value=0', ctx);
    await handlePkg1Postback('action=pkg1_variant&value=0', ctx);
    // cart に 1 件入った状態で confirm へ
    await handlePkg1Postback('action=pkg1_cart&value=confirm', ctx);
    const s = last(captured);
    expect(s).toContain('action=pkg1_confirm&value=pdf_only');
    expect(s).toContain('action=pkg1_confirm&value=reserve');
    expect(s).toContain('action=pkg1_confirm&value=redo');
  });

  it('経路 C→cart(add): 「他の整備も追加」で region 選択に戻る', async () => {
    buildStatefulSupabase();
    const captured: unknown[][] = [];
    const ctx = fakeContext(captured);

    await handlePkg1Postback('action=pkg1_dispatch&value=identified', ctx);
    await handlePkg1Postback(`action=pkg1_region&value=${BRAKE}`, ctx);
    await handlePkg1Postback('action=pkg1_symptom&value=0', ctx);
    await handlePkg1Postback('action=pkg1_variant&value=0', ctx);
    await handlePkg1Postback('action=pkg1_cart&value=add', ctx);
    expect(last(captured)).toContain('action=pkg1_region&value=brake');
  });

  it('経路 D-1: confirm(pdf_only) → 完了文言 (cases 保存)', async () => {
    buildStatefulSupabase();
    const captured: unknown[][] = [];
    const ctx = fakeContext(captured);

    await handlePkg1Postback('action=pkg1_dispatch&value=identified', ctx);
    await handlePkg1Postback(`action=pkg1_region&value=${BRAKE}`, ctx);
    await handlePkg1Postback('action=pkg1_symptom&value=0', ctx);
    await handlePkg1Postback('action=pkg1_variant&value=0', ctx);
    await handlePkg1Postback('action=pkg1_cart&value=confirm', ctx);
    await handlePkg1Postback('action=pkg1_confirm&value=pdf_only', ctx);
    expect(last(captured)).toContain('またのお問い合わせ');
  });

  it('経路 D-1: confirm(redo) → cart クリア + region 再選択', async () => {
    buildStatefulSupabase();
    const captured: unknown[][] = [];
    const ctx = fakeContext(captured);

    await handlePkg1Postback('action=pkg1_dispatch&value=identified', ctx);
    await handlePkg1Postback(`action=pkg1_region&value=${BRAKE}`, ctx);
    await handlePkg1Postback('action=pkg1_symptom&value=0', ctx);
    await handlePkg1Postback('action=pkg1_variant&value=0', ctx);
    await handlePkg1Postback('action=pkg1_cart&value=confirm', ctx);
    await handlePkg1Postback('action=pkg1_confirm&value=redo', ctx);
    const s = last(captured);
    expect(s).toContain('action=pkg1_region&value=brake');
  });

  it('経路 D-2 (同意済): confirm(reserve)→slot→reserve_confirm(ok) が全段通る', async () => {
    buildStatefulSupabase({ consentValid: true });
    const captured: unknown[][] = [];
    const ctx = fakeContext(captured);

    await handlePkg1Postback('action=pkg1_dispatch&value=identified', ctx);
    await handlePkg1Postback(`action=pkg1_region&value=${BRAKE}`, ctx);
    await handlePkg1Postback('action=pkg1_symptom&value=0', ctx);
    await handlePkg1Postback('action=pkg1_variant&value=0', ctx);
    await handlePkg1Postback('action=pkg1_cart&value=confirm', ctx);

    // reserve → 同意済なので来店日時候補の縦リストへ (店舗選択ステップは無い)
    await handlePkg1Postback('action=pkg1_confirm&value=reserve', ctx);
    const sList = last(captured);
    expect(sList).toContain('action=pkg1_reserve_slot&value=s1|');
    expect(sList).not.toContain('pkg1_reserve_store');

    // 候補 (store 内包) を 1 タップ → 確認 3 択
    const dt = futureWeekdayNoon();
    await handlePkg1Postback(`action=pkg1_reserve_slot&value=s1|${dt}`, ctx);
    const sConfirm = last(captured);
    expect(sConfirm).toContain('action=pkg1_reserve_confirm&value=ok');
    expect(sConfirm).toContain('action=pkg1_reserve_confirm&value=change');

    // 確定 ok → スタッフ連絡文言
    await handlePkg1Postback('action=pkg1_reserve_confirm&value=ok', ctx);
    expect(last(captured)).toContain('お待ちしております');
  });

  it('reservation session 失効中に reserve_slot をタップしても無反応にならない (graceful)', async () => {
    // session を一切作らずに候補選択 postback を投げる (失効/期限切れの再現)。
    buildStatefulSupabase();
    const captured: unknown[][] = [];
    const ctx = fakeContext(captured);
    await handlePkg1Postback(`action=pkg1_reserve_slot&value=s1|${futureWeekdayNoon()}`, ctx);
    // 旧実装は silent return (無反応) だった。再開導線が返ることを保証する。
    const s = last(captured);
    expect(s).toContain('もう一度はじめから');
    expect(s).toContain('action=pkg1_dispatch&value=identified');
  });

  it('reservation session 失効中に reserve_confirm をタップしても無反応にならない (graceful)', async () => {
    buildStatefulSupabase();
    const captured: unknown[][] = [];
    const ctx = fakeContext(captured);
    await handlePkg1Postback('action=pkg1_reserve_confirm&value=ok', ctx);
    expect(last(captured)).toContain('もう一度はじめから');
  });

  it('経路 D-2: reserve_confirm(change) で再度日時候補リストに戻る', async () => {
    buildStatefulSupabase({ consentValid: true });
    const captured: unknown[][] = [];
    const ctx = fakeContext(captured);

    await handlePkg1Postback('action=pkg1_dispatch&value=identified', ctx);
    await handlePkg1Postback(`action=pkg1_region&value=${BRAKE}`, ctx);
    await handlePkg1Postback('action=pkg1_symptom&value=0', ctx);
    await handlePkg1Postback('action=pkg1_variant&value=0', ctx);
    await handlePkg1Postback('action=pkg1_cart&value=confirm', ctx);
    await handlePkg1Postback('action=pkg1_confirm&value=reserve', ctx);
    const dt = futureWeekdayNoon();
    await handlePkg1Postback(`action=pkg1_reserve_slot&value=s1|${dt}`, ctx);
    await handlePkg1Postback('action=pkg1_reserve_confirm&value=change', ctx);
    expect(last(captured)).toContain('action=pkg1_reserve_slot&value=s1|');
  });
});

/**
 * 全 region × 全 symptom × 全 variant の総当たり。実機で「動かない選択肢」を
 * 構造的に潰す。各 tap が「黙って no-op / エラー文言」にならず、期待する次画面
 * (variant 選択 / qty 選択 / cart decision / スタッフ送り) のいずれかへ進むこと。
 */
describe('Pkg1 総当たり (全選択肢が反応する・wiring 監査の本丸)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetLaborCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  const ERROR_TEXT = '見積もりの処理に失敗しました';

  for (const region of REGIONS) {
    it(`region「${region.label}」(${region.value}) の全作業・全種類が反応する`, async () => {
      const symptoms = region.symptoms;

      // region 選択 → 自由記述 region はスタッフ送り (symptoms=null)。
      {
        buildStatefulSupabase();
        const captured: unknown[][] = [];
        const ctx = fakeContext(captured);
        await handlePkg1Postback('action=pkg1_dispatch&value=identified', ctx);
        await handlePkg1Postback(`action=pkg1_region&value=${region.value}`, ctx);
        const s = last(captured);
        expect(s).not.toContain(ERROR_TEXT);
        if (symptoms === null) {
          // その他（自由記述）→ スタッフ送り
          expect(s).toContain('スタッフ');
          return;
        }
        // 作業一覧 (少なくとも symptom 0 の postback) を出す
        expect(s).toContain('action=pkg1_symptom&value=0');
      }

      if (symptoms === null) return;

      // 各 symptom を index で叩く。
      for (let si = 0; si < symptoms.length; si++) {
        const symptom = symptoms[si];
        buildStatefulSupabase();
        const captured: unknown[][] = [];
        const ctx = fakeContext(captured);
        await handlePkg1Postback('action=pkg1_dispatch&value=identified', ctx);
        await handlePkg1Postback(`action=pkg1_region&value=${region.value}`, ctx);
        await handlePkg1Postback(`action=pkg1_symptom&value=${si}`, ctx);
        const s = last(captured);
        expect(s, `${region.label}/${symptom.label} (symptom ${si})`).not.toContain(ERROR_TEXT);

        const hasVariants = !!symptom.variants && symptom.variants.length > 0;
        const isStaffOnly = !hasVariants && !symptom.sample; // sample=null & variant 無し → スタッフ送り

        if (isStaffOnly) {
          expect(s, `${region.label}/${symptom.label}`).toContain('スタッフ');
          continue;
        }
        if (hasVariants) {
          expect(s, `${region.label}/${symptom.label}`).toContain('action=pkg1_variant&value=0');
          // 各 variant を叩く。
          for (let vi2 = 0; vi2 < symptom.variants!.length; vi2++) {
            const variant = symptom.variants![vi2];
            buildStatefulSupabase();
            const cap2: unknown[][] = [];
            const ctx2 = fakeContext(cap2);
            await handlePkg1Postback('action=pkg1_dispatch&value=identified', ctx2);
            await handlePkg1Postback(`action=pkg1_region&value=${region.value}`, ctx2);
            await handlePkg1Postback(`action=pkg1_symptom&value=${si}`, ctx2);
            await handlePkg1Postback(`action=pkg1_variant&value=${vi2}`, ctx2);
            const s2 = last(cap2);
            const tag = `${region.label}/${symptom.label}/${variant.label}`;
            expect(s2, tag).not.toContain(ERROR_TEXT);
            if (!variant.sample) {
              expect(s2, tag).toContain('スタッフ'); // sample=null → スタッフ送り
            } else if (symptom.qty) {
              expect(s2, tag).toContain('action=pkg1_qty&value='); // qty を聞く
            } else {
              expect(s2, tag).toContain('action=pkg1_cart&value=confirm'); // 直 cart decision
            }
          }
          continue;
        }
        // variant 無し・sample あり: qty 有無で分岐
        if (symptom.qty) {
          expect(s, `${region.label}/${symptom.label}`).toContain('action=pkg1_qty&value=');
        } else {
          expect(s, `${region.label}/${symptom.label}`).toContain('action=pkg1_cart&value=confirm');
        }
      }
    });
  }
});

/** 14 日以内の平日 12:00 (JST) を datetimepicker 形式 "YYYY-MM-DDtHH:mm" で返す。 */
function futureWeekdayNoon(): string {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  // 土日を避ける
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}t12:00`;
}
