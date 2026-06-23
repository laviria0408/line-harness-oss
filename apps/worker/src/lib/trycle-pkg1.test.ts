/**
 * Pkg1 整備見積 — state machine tests (本物 pkg1-estimate.test.ts の port)。
 *
 * Supabase REST は in-memory モックで bot_sessions / labor_master / stores /
 * case_statuses / cases / quotes / quote_versions / tenant_fy_counters /
 * consents / customers を扱う。LineClient はキャプチャ用の stub。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handlePkg1Postback, handlePkg1Text, isPkg1Postback } from './trycle-pkg1.js';
import { resetLaborCache } from './trycle-pkg1-repo.js';
import { findRegionByValue } from '../data/pkg1-regions.js';
import type { Env } from '../index.js';

const USER = 'U-test';
const TENANT = 't-1';

// ── in-memory Supabase ───────────────────────────────────────────────────────

interface Tables {
  bot_sessions: Record<string, unknown>[];
  labor_master: Record<string, unknown>[];
  stores: Record<string, unknown>[];
  case_statuses: Record<string, unknown>[];
  cases: Record<string, unknown>[];
  quotes: Record<string, unknown>[];
  quote_versions: Record<string, unknown>[];
  tenant_fy_counters: Record<string, unknown>[];
  consents: Record<string, unknown>[];
  customers: Record<string, unknown>[];
}

let tables: Tables;
let idSeq = 0;

function laborSeed() {
  // 必要な sample のみ用意 (テストで使う code)。
  return [
    { id: 'la1', tenant_id: TENANT, code: 'brake-adjust-both', category: 'brake', name: 'ブレーキ調整', price: 3000, price_open_ended: false, notes: null, archived: false, sort_order: 0 },
    { id: 'la2', tenant_id: TENANT, code: 'chain-swap', category: 'drivetrain', name: 'チェーン交換', price: 2000, price_open_ended: false, notes: null, archived: false, sort_order: 1 },
    { id: 'la3', tenant_id: TENANT, code: 'spoke-swap', category: 'wheel', name: 'スポーク交換', price: 1500, price_open_ended: false, notes: null, archived: false, sort_order: 2 },
  ];
}

function resetTables(): void {
  tables = {
    bot_sessions: [],
    labor_master: laborSeed(),
    stores: [
      {
        id: 's1',
        tenant_id: TENANT,
        name: '矢野口本店',
        code: 'Y',
        business_hours: { mon: ['10:00', '19:00'], tue: ['10:00', '19:00'], wed: ['10:00', '19:00'], thu: ['10:00', '19:00'], fri: ['10:00', '19:00'], sat: ['10:00', '19:00'], sun: ['10:00', '19:00'] },
        reservation_slot_minutes: 30,
        is_active: true,
        sort_order: 0,
      },
      { id: 's2', tenant_id: TENANT, name: '宮ヶ瀬店', code: 'M', business_hours: {}, reservation_slot_minutes: 30, is_active: true, sort_order: 1 },
    ],
    case_statuses: [{ id: 'st1', tenant_id: TENANT, key: 'new', label: '新規受付', sort_order: 0 }],
    cases: [],
    quotes: [],
    quote_versions: [],
    tenant_fy_counters: [],
    consents: [],
    customers: [],
  };
  idSeq = 0;
}

function parseFilters(url: URL): Record<string, string> {
  const f: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (k === 'select' || k === 'limit' || k === 'order' || k === 'on_conflict') continue;
    f[k] = v;
  }
  return f;
}

function matchRow(row: Record<string, unknown>, filters: Record<string, string>): boolean {
  for (const [key, expr] of Object.entries(filters)) {
    const [op, ...rest] = expr.split('.');
    const val = rest.join('.');
    const cell = row[key];
    if (op === 'eq') {
      if (String(cell) !== val) return false;
    } else if (op === 'is') {
      if (val === 'null' && cell != null) return false;
    }
  }
  return true;
}

function tableName(url: URL): keyof Tables {
  const m = url.pathname.match(/\/rest\/v1\/([^?]+)/);
  return decodeURIComponent(m![1]) as keyof Tables;
}

async function supabaseMock(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const table = tableName(url);
  const method = (init?.method as string) ?? 'GET';
  const rows = tables[table] ?? [];

  if (method === 'GET') {
    const filters = parseFilters(url);
    const matched = rows.filter((r) => matchRow(r, filters));
    return new Response(JSON.stringify(matched), { status: 200 });
  }
  if (method === 'POST') {
    const body = JSON.parse((init!.body as string) ?? '[]') as Record<string, unknown>[];
    const onConflict = url.searchParams.get('on_conflict');
    const returning: Record<string, unknown>[] = [];
    for (const incoming of body) {
      let existing: Record<string, unknown> | undefined;
      if (onConflict) {
        const keys = onConflict.split(',');
        existing = rows.find((r) => keys.every((k) => String(r[k]) === String(incoming[k])));
      }
      if (existing) {
        Object.assign(existing, incoming);
        returning.push(existing);
      } else {
        const created = { id: incoming.id ?? `row-${++idSeq}`, ...incoming };
        rows.push(created);
        returning.push(created);
      }
    }
    const prefer = (init!.headers as Record<string, string>)?.Prefer ?? '';
    if (typeof prefer === 'string' && prefer.includes('return=representation')) {
      return new Response(JSON.stringify(returning), { status: 201 });
    }
    return new Response(null, { status: 201 });
  }
  if (method === 'DELETE') {
    const filters = parseFilters(url);
    const removed = rows.filter((r) => matchRow(r, filters));
    tables[table] = rows.filter((r) => !matchRow(r, filters));
    const prefer = (init!.headers as Record<string, string>)?.Prefer ?? '';
    if (typeof prefer === 'string' && prefer.includes('return=representation')) {
      // claim-and-delete: 消した行を返す (二重押下の冪等化テスト用)。
      return new Response(JSON.stringify(removed), { status: 200 });
    }
    return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 200 });
}

// ── LineClient stub ───────────────────────────────────────────────────────────

let replied: unknown[][] = [];
let pushed: unknown[][] = [];

const lineClient = {
  replyMessage: vi.fn(async (_token: string, messages: unknown[]) => {
    replied.push(messages);
  }),
  pushMessage: vi.fn(async (_to: string, messages: unknown[]) => {
    pushed.push(messages);
  }),
} as unknown as import('@line-crm/line-sdk').LineClient;

function env(): Env['Bindings'] {
  return {
    SUPABASE_URL: 'https://sb.example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
    TRYCLE_TENANT_ID: TENANT,
    // GAS / Gmail / LIFF は未設定で graceful degrade を効かせる。
  } as Env['Bindings'];
}

function ctx() {
  return { replyToken: `rt-${Math.random()}`, lineUserId: USER, lineClient, env: env() };
}

async function postback(data: string, extra: { datetime?: string } = {}): Promise<boolean> {
  return handlePkg1Postback(data, { ...ctx(), ...extra });
}

function lastReplyText(): string {
  const msgs = replied.at(-1) ?? [];
  return JSON.stringify(msgs);
}

// 全 reply (複数ターン分) を平坦化して JSON 文字列化する。
// postback の action/value など、テキスト以外のフィールドも含めて検証したいときに使う。
function lastReplyAny(): string {
  return JSON.stringify(replied);
}

function sessionStep(): string | undefined {
  const s = tables.bot_sessions.find(
    (r) => r.line_user_id === USER && r.kind === 'pkg1_estimate',
  );
  return (s?.state as { step?: string } | undefined)?.step;
}

function sessionReservationStep(): string | undefined {
  const s = tables.bot_sessions.find(
    (r) => r.line_user_id === USER && r.kind === 'reservation',
  );
  return (s?.state as { step?: string } | undefined)?.step;
}

function cart(): unknown[] {
  const s = tables.bot_sessions.find(
    (r) => r.line_user_id === USER && r.kind === 'pkg1_estimate',
  );
  return ((s?.state as { cart?: unknown[] } | undefined)?.cart) ?? [];
}

// ── helpers: 部位/作業/variant の index を本物カタログから引く ─────────────────

const brake = findRegionByValue('brake')!;
const BRAKE_ADJUST = 0; // ブレーキ調整 (variants: 両側/片側)
const drivetrain = findRegionByValue('drivetrain')!;
const CHAIN_SWAP = drivetrain.symptoms!.findIndex((s) => s.label === 'チェーン交換');
const DRIVETRAIN_OTHER = drivetrain.symptoms!.findIndex((s) => s.label === 'その他');
const wheel = findRegionByValue('wheel')!;
const SPOKE_SWAP = wheel.symptoms!.findIndex((s) => s.label === 'スポーク交換');

beforeEach(() => {
  resetTables();
  resetLaborCache();
  replied = [];
  pushed = [];
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', vi.fn(supabaseMock));
});

// ── isPkg1Postback ────────────────────────────────────────────────────────────

describe('isPkg1Postback', () => {
  it('matches bare entry + action= form', () => {
    expect(isPkg1Postback('pkg1_start')).toBe(true);
    expect(isPkg1Postback('pkg1_wage')).toBe(true);
    expect(isPkg1Postback('action=pkg1_dispatch&value=identified')).toBe(true);
    expect(isPkg1Postback('action=pkg1_reserve_store&value=s1')).toBe(true);
    expect(isPkg1Postback('action=pkg1_reserve_time&value=s1|2026-06-22t14:00')).toBe(true);
    expect(isPkg1Postback('pkg8_start')).toBe(false);
    expect(isPkg1Postback('action=faq_x')).toBe(false);
  });
});

// ── ① 状況ふりわけ (REQ-002) ─────────────────────────────────────────────────

describe('dispatch (REQ-PKG1-002)', () => {
  it('原因特定済み advances to region selection (LH 準拠 Flex 縦リスト)', async () => {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    const s = lastReplyText();
    // LH 準拠 Flex 縦リスト (Carousel テンプレートに退化していないこと)。
    expect(s).toContain('"type":"flex"');
    expect(s).toContain('action=pkg1_region&value=brake');
    expect(s).not.toContain('carousel');
    expect(sessionStep()).toBe('awaiting_region');
  });

  it('包括メンテ escalates to staff (manual_mode + session cleared)', async () => {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=comprehensive');
    expect(lastReplyText()).toContain('現物確認が必要');
    expect(sessionStep()).toBeUndefined();
    expect(tables.bot_sessions.some((r) => r.kind === 'manual_mode')).toBe(true);
  });

  it('原因がわからない escalates to staff', async () => {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=unknown');
    expect(tables.bot_sessions.some((r) => r.kind === 'manual_mode')).toBe(true);
  });
});

// ── フルフロー: region → symptom → variant → cart ─────────────────────────────

describe('full identified flow', () => {
  async function walkToCartDecision() {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    await postback('action=pkg1_region&value=brake');
    await postback(`action=pkg1_symptom&value=${BRAKE_ADJUST}`);
    await postback('action=pkg1_variant&value=0'); // 両側 brake-adjust-both ¥3,000
  }

  it('adds an item and shows the cart decision prompt', async () => {
    await walkToCartDecision();
    expect(lastReplyText()).toContain('ブレーキ調整（両側）');
    expect(lastReplyText()).toContain('¥3,000');
    expect(sessionStep()).toBe('awaiting_cart_decision');
    expect(cart()).toHaveLength(1);
  });

  it('accumulates multiple items', async () => {
    await walkToCartDecision();
    await postback('action=pkg1_cart&value=add');
    await postback('action=pkg1_region&value=drivetrain');
    await postback(`action=pkg1_symptom&value=${CHAIN_SWAP}`); // chain-swap ¥2,000 (no variants)
    expect(cart()).toHaveLength(2);
    const total = (cart() as { amount: number }[]).reduce((s, i) => s + i.amount, 0);
    expect(total).toBe(5000);
  });

  it('confirm shows the 3-択 prompt', async () => {
    await walkToCartDecision();
    await postback('action=pkg1_cart&value=confirm');
    const s = lastReplyText();
    expect(s).toContain('PDF だけ受け取る');
    expect(s).toContain('ご来店予定を伝える');
    expect(s).toContain('やり直す');
    expect(sessionStep()).toBe('awaiting_confirm');
  });
});

// ── 経路 D-1: pdf_only (cases + quote_versions 保存・session 削除) ─────────────

describe('pdf_only route (経路 D-1・v1.2.1 見積保存)', () => {
  async function walkToConfirm() {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    await postback('action=pkg1_region&value=brake');
    await postback(`action=pkg1_symptom&value=${BRAKE_ADJUST}`);
    await postback('action=pkg1_variant&value=0');
    await postback('action=pkg1_cart&value=confirm');
  }

  it('saves a case + quote_version, clears session, and replies with 終了 message', async () => {
    await walkToConfirm();
    await postback('action=pkg1_confirm&value=pdf_only');
    expect(tables.cases).toHaveLength(1);
    expect(tables.cases[0].customer_id).toBeNull();
    expect(tables.cases[0].work_note).toBe('pdf_only');
    expect(tables.quotes).toHaveLength(1);
    expect(tables.quote_versions).toHaveLength(1);
    expect(lastReplyText()).toContain('またのお問い合わせ');
    expect(sessionStep()).toBeUndefined();
  });

  // ケース ② (来店予約 → PDF): 既に customer がいれば新 PDF case に継承する。
  it('inherits the existing customer_id when a customer already exists', async () => {
    tables.customers.push({ id: 'cust-7', tenant_id: TENANT, line_user_id: USER, name: '田中', phone: null, email: null });
    await walkToConfirm();
    await postback('action=pkg1_confirm&value=pdf_only');
    expect(tables.cases).toHaveLength(1);
    expect(tables.cases[0].customer_id).toBe('cust-7');
  });
});

// ── 経路 D-2: 来店予定 → 同意書ゲート (来店予定押下直後) ───────────────────────

describe('reserve route (経路 D-2・同意書ゲート)', () => {
  async function walkToConfirm() {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    await postback('action=pkg1_region&value=brake');
    await postback(`action=pkg1_symptom&value=${BRAKE_ADJUST}`);
    await postback('action=pkg1_variant&value=0');
    await postback('action=pkg1_cart&value=confirm');
  }

  it('未同意なら来店予定押下直後に同意書プロンプト + cart 退避', async () => {
    await walkToConfirm();
    await postback('action=pkg1_confirm&value=reserve');
    expect(lastReplyText()).toContain('整備同意書');
    expect(sessionStep()).toBe('awaiting_consent_form');
    // cart が pkg1_cart に退避されている
    expect(tables.bot_sessions.some((r) => r.kind === 'pkg1_cart')).toBe(true);
  });

  it('同意済なら同意書をスキップして店舗選択 carousel に進む', async () => {
    tables.consents.push({
      tenant_id: TENANT,
      line_user_id: USER,
      source: 'maintenance-consent',
      consented_at: new Date().toISOString(),
    });
    await walkToConfirm();
    await postback('action=pkg1_confirm&value=reserve');
    expect(lastReplyText()).toContain('ご来店店舗をお選びください');
    // 店舗選択は店舗を指す postback で出る (3 段階フローの ①)。
    expect(lastReplyAny()).toContain('action=pkg1_reserve_store&value=s1');
    const reservation = tables.bot_sessions.find((r) => r.kind === 'reservation');
    expect((reservation?.state as { step?: string })?.step).toBe('awaiting_store');
  });
});

// ── 来店予定: 3 段階フロー (店舗 → 日付 → 時間 → 確認 → 完了) ──────────────────

describe('reservation flow (店舗 → 日付 → 時間 → 確認)', () => {
  async function reachStoreSelection() {
    tables.consents.push({
      tenant_id: TENANT,
      line_user_id: USER,
      source: 'maintenance-consent',
      consented_at: new Date().toISOString(),
    });
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    await postback('action=pkg1_region&value=brake');
    await postback(`action=pkg1_symptom&value=${BRAKE_ADJUST}`);
    await postback('action=pkg1_variant&value=0');
    await postback('action=pkg1_cart&value=confirm');
    await postback('action=pkg1_confirm&value=reserve');
  }

  it('① shows a store carousel directly after 来店予定 (3 段階フローの起点)', async () => {
    await reachStoreSelection();
    const s = lastReplyAny();
    expect(s).toContain('action=pkg1_reserve_store&value=s1');
    // 旧 Option A の店舗内包 slot postback は出ない。
    expect(s).not.toContain('pkg1_reserve_slot');
    expect(sessionReservationStep()).toBe('awaiting_store');
  });

  it('② store → date list (定休日除外済みの営業日)', async () => {
    await reachStoreSelection();
    await postback('action=pkg1_reserve_store&value=s1');
    const s = lastReplyAny();
    // 矢野口 (s1) は毎日 10:00-19:00。営業日が日付 postback で出る。
    expect(s).toContain('action=pkg1_reserve_date&value=');
    expect(sessionReservationStep()).toBe('awaiting_date');
  });

  it('③ date → time list (選んだ日の slots)', async () => {
    await reachStoreSelection();
    await postback('action=pkg1_reserve_store&value=s1');
    const dt = nextMondayAt14();
    const date = dt.slice(0, 10);
    await postback(`action=pkg1_reserve_date&value=${date}`);
    const s = lastReplyAny();
    expect(s).toContain(`action=pkg1_reserve_time&value=${date}t`);
    expect(sessionReservationStep()).toBe('awaiting_time');
  });

  it('walks store → date → time → confirm → ok and saves a 来店予定 case', async () => {
    await reachStoreSelection();
    await postback('action=pkg1_reserve_store&value=s1');
    const dt = nextMondayAt14();
    const date = dt.slice(0, 10);
    await postback(`action=pkg1_reserve_date&value=${date}`);
    await postback(`action=pkg1_reserve_time&value=${dt}`);
    expect(lastReplyText()).toContain('来店予定でよろしいですか');
    await postback('action=pkg1_reserve_confirm&value=ok');
    expect(lastReplyText()).toContain('お待ちしております');
    expect(tables.cases).toHaveLength(1);
    expect(tables.cases[0].work_note).toBe('来店予定');
    // visit_scheduled_at は JST 壁時計 ("YYYY-MM-DDtHH:mm") を timestamptz 用に
    // "+09:00" 付き ISO に変換して保存 (dashboard 表示の +9h ズレ防止・jstWallToIsoZ)。
    expect(tables.cases[0].visit_scheduled_at).toBe(
      dt.replace('t', 'T') + ':00+09:00',
    );
    expect(tables.quote_versions).toHaveLength(1);
    // reservation session is cleared
    expect(tables.bot_sessions.some((r) => r.kind === 'reservation')).toBe(false);
  });

  it('re-offers a date when a non-business-day date value is tapped (二重チェック)', async () => {
    await reachStoreSelection();
    await postback('action=pkg1_reserve_store&value=s1');
    // 1900-01-01 は候補 (14 日窓) に無い → 別日選択を促し無反応にしない。
    await postback('action=pkg1_reserve_date&value=1900-01-01');
    expect(lastReplyText()).toContain('別の日をお選びください');
    expect(tables.cases).toHaveLength(0);
  });

  it('「別の日時にする」 returns to the time list keeping the date', async () => {
    await reachStoreSelection();
    await postback('action=pkg1_reserve_store&value=s1');
    const dt = nextMondayAt14();
    const date = dt.slice(0, 10);
    await postback(`action=pkg1_reserve_date&value=${date}`);
    await postback(`action=pkg1_reserve_time&value=${dt}`);
    await postback('action=pkg1_reserve_confirm&value=change');
    expect(lastReplyText()).toContain('別の時間をお選びください');
    // 同じ日の time list に戻る (date 維持)。
    expect(lastReplyAny()).toContain(`action=pkg1_reserve_time&value=${date}t`);
    expect(sessionReservationStep()).toBe('awaiting_time');
    expect(tables.cases).toHaveLength(0);
  });

  // ── 二重押下の冪等化 (2026-06-23 真因: 「はい」連打で 2 案件) ─────────────────
  it('confirm=ok を 2 回押しても case は 1 件だけ作られる (idempotent claim)', async () => {
    await reachStoreSelection();
    await postback('action=pkg1_reserve_store&value=s1');
    const dt = nextMondayAt14();
    const date = dt.slice(0, 10);
    await postback(`action=pkg1_reserve_date&value=${date}`);
    await postback(`action=pkg1_reserve_time&value=${dt}`);

    // 1 回目: case 作成 + 引継 reply。
    await postback('action=pkg1_reserve_confirm&value=ok');
    expect(tables.cases).toHaveLength(1);
    expect(tables.quote_versions).toHaveLength(1);
    // 確定で reservation session は消えている。
    expect(tables.bot_sessions.some((r) => r.kind === 'reservation')).toBe(false);

    // 2 回目 (連打 / webhook retry 相当): session は claim 済みで空 → 二重 finalize
    // は起きず graceful フォールバックを返す。
    await postback('action=pkg1_reserve_confirm&value=ok');
    // case / quote_version が増えない (= スタッフ引継も二重にならない)。
    expect(tables.cases).toHaveLength(1);
    expect(tables.quote_versions).toHaveLength(1);
    // 2 回目は確定文言ではなく再開導線 (reservationLost)。
    expect(lastReplyText()).toContain('もう一度はじめから');
  });
});

// ── escalation paths (REQ-018) ────────────────────────────────────────────────

describe('escalation paths (REQ-PKG1-018)', () => {
  it('region=その他(自由記述) escalates', async () => {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    await postback('action=pkg1_region&value=other');
    expect(tables.bot_sessions.some((r) => r.kind === 'manual_mode')).toBe(true);
    expect(sessionStep()).toBeUndefined();
  });

  it('symptom=その他 (sample=null) escalates', async () => {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    await postback('action=pkg1_region&value=drivetrain');
    await postback(`action=pkg1_symptom&value=${DRIVETRAIN_OTHER}`);
    expect(tables.bot_sessions.some((r) => r.kind === 'manual_mode')).toBe(true);
  });
});

// ── escalate → notifyStaff の種別タグ判定 (Add-D / Add-F) ──────────────────────
//
// audit-coverage 指摘の実証: 旧実装は escalate() が notifyStaff に「reason のみ」
// (定型文字列) を渡し、classifyInquiry が定型 reason を誤分類していた
// (確定不能症状 → other 固定)。修正後は「お客様の選択ラベル」を inquiryText として
// 渡すため、選択起点で種別タグが判定される (REQ-ADD-D-001 メニュー起点判定)。
describe('escalate → staff 通知の種別タグ (Add-D / Add-F)', () => {
  // gmail_notify (callGas → GAS_WEB_APP_URL) の POST を捕捉する。
  let gasCalls: { type: string; payload: Record<string, unknown> }[];
  const GAS_URL = 'https://gas.example.com/exec';

  function gasEnv(): Env['Bindings'] {
    return {
      SUPABASE_URL: 'https://sb.example.com',
      SUPABASE_SERVICE_ROLE_KEY: 'svc',
      TRYCLE_TENANT_ID: TENANT,
      GAS_WEB_APP_URL: GAS_URL,
      GMAIL_NOTIFICATION_TO: 'staff@example.com',
    } as Env['Bindings'];
  }

  async function gasPostback(data: string): Promise<boolean> {
    return handlePkg1Postback(data, {
      replyToken: `rt-${Math.random()}`,
      lineUserId: USER,
      lineClient,
      env: gasEnv(),
    });
  }

  beforeEach(() => {
    gasCalls = [];
    // supabase URL は既存 mock へ・GAS URL は捕捉して ok を返す。
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith(GAS_URL)) {
          gasCalls.push(JSON.parse((init!.body as string) ?? '{}'));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return supabaseMock(input, init);
      }),
    );
  });

  function lastStaffNotify(): Record<string, unknown> | undefined {
    return gasCalls.filter((c) => c.type === 'gmail_notify').at(-1)?.payload;
  }

  it('region=その他 escalate は選択ラベル (定型 reason ではない) を分類根拠にする', async () => {
    await gasPostback('pkg1_start');
    await gasPostback('action=pkg1_dispatch&value=identified');
    await gasPostback('action=pkg1_region&value=other');

    const payload = lastStaffNotify();
    expect(payload).toBeDefined();
    // 「その他（自由記述）」= サービス種別不明 → other (旧実装と値は同じだが、
    // 分類の起点が定型 reason でなく選択ラベルになっていることが要点)。
    expect(payload!.tag).toBe('other');
    // 確定不能症状 (canned reason) でなく、有人モードへ切り替わっている。
    expect(tables.bot_sessions.some((r) => r.kind === 'manual_mode')).toBe(true);
  });

  it('カーボン補修ルートで escalate すると carbon タグ + 矢野口固定で通知 (REQ-ADD-F-002)', async () => {
    // 顧客自由文起点の routing 実証: お客様の発話 (カーボン補修) が分類根拠になれば、
    // 希望店舗に関わらず矢野口本店へ振り分けられる。escalate がお客様の文言を
    // inquiryText として通知するため、カーボン関連の選択ラベルなら carbon タグになる。
    // ※ 現行メニューにカーボン項目は無いため、ここは classifyInquiry の不変条件を
    //    notifyStaff payload レベルで担保する直接検証 (routeInquiry の単体は
    //    trycle-staff.test.ts)。
    const { notifyStaff } = await import('./trycle-staff.js');
    const res = await notifyStaff(gasEnv(), {
      lineUserId: USER,
      customerName: null,
      reason: '確定不能症状',
      estimateSummary: null,
      pdfUrl: null,
      note: null,
      inquiryText: 'カーボンフレームのクラック補修をお願いしたい',
      preferredShop: 'miyagase', // 宮ヶ瀬希望でも carbon は矢野口固定
    });
    expect(res.tag).toBe('carbon');
    expect(res.shopId).toBe('yano');

    const payload = lastStaffNotify();
    expect(payload!.tag).toBe('carbon');
    expect(payload!.shop_id).toBe('yano');
    expect(payload!.shop_label).toBe('矢野口本店');
  });

  it('定型 reason をそのまま分類すると誤る (回帰防止: 来店予定は reservation, 確定不能症状は other)', async () => {
    // classifyInquiry に canned reason を直接渡したときの値を固定し、escalate が
    // この誤りやすい入力を分類根拠にしてしまわないこと (=選択ラベルを渡すこと) の
    // 根拠を残す。
    const { classifyInquiry } = await import('./trycle-staff.js');
    expect(classifyInquiry('確定不能症状')).toBe('other');
    expect(classifyInquiry('包括メンテしたい')).toBe('other');
    expect(classifyInquiry('原因がわからない')).toBe('other');
    // 「来店予定の受付」だけは 来店 を拾って reservation になる (偶然の正解)。
    expect(classifyInquiry('来店予定の受付')).toBe('reservation');
  });
});

// ── qty step (v1.2.1: 制限なし・任意数量) ─────────────────────────────────────

describe('qty step (v1.2.1: 任意数量で cart 追加)', () => {
  async function reachQty() {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    await postback('action=pkg1_region&value=wheel');
    await postback(`action=pkg1_symptom&value=${SPOKE_SWAP}`); // spoke-swap qty=count
  }

  it('asks for qty when the symptom has qty', async () => {
    await reachQty();
    expect(sessionStep()).toBe('awaiting_qty');
    expect(lastReplyText()).toContain('数量');
  });

  it('adds the item with the chosen qty (button = 2)', async () => {
    await reachQty();
    await postback('action=pkg1_qty&value=2');
    expect(sessionStep()).toBe('awaiting_cart_decision');
    expect((cart()[0] as { qty: number }).qty).toBe(2);
  });

  it('accepts an arbitrary qty typed as text (3 本以上 OK・no escalation)', async () => {
    await reachQty();
    const handled = await handlePkg1Text('5', ctx());
    expect(handled).toBe(true);
    expect((cart()[0] as { qty: number }).qty).toBe(5);
    // v1.2.1: 3 本以上でもスタッフ送りにならない
    expect(tables.bot_sessions.some((r) => r.kind === 'manual_mode')).toBe(false);
  });
});

// ── 経路 E: pkg1_wage で同意書単体提出 LIFF を出す ────────────────────────────

describe('経路 E: pkg1_wage (来店時補完の同意書単体提出)', () => {
  it('replies with the consent prompt (準備中 when no LIFF URL)', async () => {
    await postback('pkg1_wage');
    expect(lastReplyText()).toContain('整備同意書');
  });
});

// ── helper ────────────────────────────────────────────────────────────────────

function nextMondayAt14(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  // 次の月曜まで進める (UTC getUTCDay: 1 = Monday)。
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() !== 1);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}t14:00`;
}
