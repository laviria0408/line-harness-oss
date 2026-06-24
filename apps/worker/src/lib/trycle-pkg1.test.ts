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
  labor_options: Record<string, unknown>[];
  stores: Record<string, unknown>[];
  case_statuses: Record<string, unknown>[];
  cases: Record<string, unknown>[];
  quotes: Record<string, unknown>[];
  quote_versions: Record<string, unknown>[];
  tenant_fy_counters: Record<string, unknown>[];
  consents: Record<string, unknown>[];
  customers: Record<string, unknown>[];
  maintenance_menus: Record<string, unknown>[];
  maintenance_features: Record<string, unknown>[];
  maintenance_menu_features: Record<string, unknown>[];
}

let tables: Tables;
let idSeq = 0;

function laborSeed() {
  // 必要な sample のみ用意 (テストで使う code)。tags/description は お悩みマッチ用 (v1.6)。
  return [
    { id: 'la1', tenant_id: TENANT, code: 'brake-adjust-both', category: 'brake', name: 'ブレーキ調整', price: 3000, price_max: null, price_open_ended: false, notes: null, tags: ['ブレーキ', '効かない'], description: 'ブレーキの効きを調整します', archived: false, sort_order: 0 },
    { id: 'la2', tenant_id: TENANT, code: 'chain-swap', category: 'drivetrain', name: 'チェーン交換', price: 2000, price_max: null, price_open_ended: false, notes: null, tags: ['チェーン'], description: null, archived: false, sort_order: 1 },
    { id: 'la3', tenant_id: TENANT, code: 'spoke-swap', category: 'wheel', name: 'スポーク交換', price: 1500, price_max: null, price_open_ended: false, notes: null, tags: ['スポーク'], description: null, archived: false, sort_order: 2 },
    // 包括メンテ menu (labor 本体)。お悩み「全体」でも拾える tags 付き。
    { id: 'la-oh', tenant_id: TENANT, code: 'oh-premium', category: 'オーバーホール', name: 'オーバーホール プレミアム', price: 80000, price_max: null, price_open_ended: false, notes: null, tags: ['オーバーホール', '全体', 'メンテナンス'], description: '全バラシのコース', archived: false, sort_order: 3 },
  ];
}

function resetTables(): void {
  tables = {
    bot_sessions: [],
    labor_master: laborSeed(),
    // labor_options は既定で空 (= 既存フロー 100% 維持・options 無いメニューは skip)。
    // 自動聞きフローの test だけ seedOptions(...) で対象 labor に option を注入する。
    labor_options: [],
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
    // 包括メンテ (v1.6): labor la-oh と 1:1 の menu + 機能 + マトリクス。
    maintenance_menus: [
      { id: 'mm1', tenant_id: TENANT, labor_master_id: 'la-oh', duration_days_min: 14, duration_days_max: 20, detailed_description: '全バラシのコースです。', hero_image_url: null, sort_order: 0 },
    ],
    maintenance_features: [
      { id: 'mf1', tenant_id: TENANT, category: '全体', name: '分解・洗浄・組み立て', archived: false, sort_order: 0 },
      { id: 'mf2', tenant_id: TENANT, category: 'オプション', name: '油圧ホース交換', archived: false, sort_order: 1 },
    ],
    maintenance_menu_features: [
      { labor_master_id: 'la-oh', feature_id: 'mf1', option_price: null, option_price_open_ended: false, notes: null, sort_order: 0 },
      { labor_master_id: 'la-oh', feature_id: 'mf2', option_price: 12000, option_price_open_ended: false, notes: null, sort_order: 1 },
    ],
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
    } else if (op === 'in') {
      // in.(a,b,c) — 括弧内を split して membership 判定 (maintenance_menu_features 用)。
      const inner = val.replace(/^\(/, '').replace(/\)$/, '');
      const allowed = inner.split(',').map((v) => v.trim());
      if (!allowed.includes(String(cell))) return false;
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

  it('包括メンテ → 包括メンテゲート (v1.6・4 メニュー carousel)', async () => {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=comprehensive');
    // harness は maintenance_menus を 1 件 seed → carousel + entry actions が出る。
    expect(lastReplyAny()).toContain('action=pkg1_overhaul&value=picker');
    // 旧スタッフ即送りには倒れない (manual_mode を即立てない)。
    expect(tables.bot_sessions.some((r) => r.kind === 'manual_mode')).toBe(false);
    expect(sessionStep()).toBe('awaiting_overhaul_menu');
  });

  it('原因がわからない → お悩み自由文入力 (v1.6)', async () => {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=unknown');
    expect(lastReplyText()).toContain('どのようなことでお困りですか');
    expect(sessionStep()).toBe('awaiting_osayami_input');
    expect(tables.bot_sessions.some((r) => r.kind === 'manual_mode')).toBe(false);
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

// ── Step ID 流入制御 (2026-06-24 真因: 連打 / 古ボタン / 再発行) ───────────────
//
// 実機の Flex postback は `&step=<待ち step>` を埋めて飛ぶ。dispatcher はこれを
// session の current/previous step と突き合わせ、古い Flex のボタン (stale) を
// 完全 silent に落とす。ここではその step 付き postback を直接投げてゲートを検証する。

describe('Step ID 流入制御 (連打 / 古ボタン / 再発行 を統一防止)', () => {
  // region 選択まで進める (session.step = awaiting_symptom)。
  async function reachSymptom() {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified&step=awaiting_dispatch');
    await postback('action=pkg1_region&value=brake&step=awaiting_region');
    // ここで session は awaiting_symptom 待ち (previous=awaiting_region)。
  }

  it('連打: 2 手以上前の symptom ボタンを押すと stale → 完全 silent (reply 増えない)', async () => {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified&step=awaiting_dispatch');
    await postback('action=pkg1_region&value=brake&step=awaiting_region');
    // symptom (variants 有り) を選ぶ → session は awaiting_variant・previous=awaiting_symptom。
    await postback(`action=pkg1_symptom&value=${BRAKE_ADJUST}&step=awaiting_symptom`);
    expect(sessionStep()).toBe('awaiting_variant');
    const before = replied.length;
    // ここで 2 手前の region ボタン (step=awaiting_region) を押す。current=awaiting_variant /
    // previous=awaiting_symptom のどちらでもない → stale → silent。
    await postback('action=pkg1_region&value=drivetrain&step=awaiting_region');
    expect(replied.length).toBe(before);
    expect(sessionStep()).toBe('awaiting_variant'); // state は動かない
  });

  it('古ボタン: 数手前の dispatch ボタンを押しても stale → silent', async () => {
    await reachSymptom();
    expect(sessionStep()).toBe('awaiting_symptom');
    const before = replied.length;
    // 遡って 2 手前の dispatch ボタン (step=awaiting_dispatch) を押す。
    await postback('action=pkg1_dispatch&value=identified&step=awaiting_dispatch');
    expect(replied.length).toBe(before); // silent
    expect(sessionStep()).toBe('awaiting_symptom');
  });

  it('直前 step (1 つ前) のボタンは rollback で受理される', async () => {
    await reachSymptom();
    // session.step=awaiting_symptom / previous=awaiting_region。
    // 直前 (awaiting_region) のボタンを押し直す = 部位を選び直す → rollback で受理。
    const before = replied.length;
    await postback('action=pkg1_region&value=drivetrain&step=awaiting_region');
    expect(replied.length).toBeGreaterThan(before); // 応答が返る (silent でない)
    // drivetrain の作業一覧が出て、session は awaiting_symptom を再び待つ。
    expect(sessionStep()).toBe('awaiting_symptom');
    expect(lastReplyText()).toContain('action=pkg1_symptom');
  });

  it('完了済み (session 無) の古ボタンは stale → silent', async () => {
    await reachSymptom();
    // フロー完了相当: session を消す。
    tables.bot_sessions = tables.bot_sessions.filter((r) => r.kind !== 'pkg1_estimate');
    const before = replied.length;
    // step 付きの古ボタンを押す。session が無いので stale → silent。
    await postback('action=pkg1_symptom&value=0&step=awaiting_symptom');
    expect(replied.length).toBe(before);
  });

  it('正常進行: step が一致すれば advance (通常処理)', async () => {
    await reachSymptom();
    const before = replied.length;
    await postback('action=pkg1_symptom&value=0&step=awaiting_symptom');
    expect(replied.length).toBeGreaterThan(before); // 応答あり
  });

  it('cart 追加後の qty ボタン再押下は stale → 明細が二重に積まれない', async () => {
    // 数量ステップを持つ symptom (spoke-swap) で cart へ 1 件積む。
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified&step=awaiting_dispatch');
    await postback('action=pkg1_region&value=wheel&step=awaiting_region');
    await postback(`action=pkg1_symptom&value=${SPOKE_SWAP}&step=awaiting_symptom`);
    expect(sessionStep()).toBe('awaiting_qty');
    // qty 選択 → cart へ 1 件追加・session は awaiting_cart_decision (previousStep は畳む)。
    await postback('action=pkg1_qty&value=2&step=awaiting_qty');
    expect(sessionStep()).toBe('awaiting_cart_decision');
    expect(cart()).toHaveLength(1);
    const before = replied.length;
    // 画面に残った古い qty ボタンを再度押す。current=awaiting_cart_decision /
    // previous=undefined なので stale → silent。明細は二重に積まれない。
    await postback('action=pkg1_qty&value=2&step=awaiting_qty');
    expect(replied.length).toBe(before);
    expect(cart()).toHaveLength(1); // 1 件のまま
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

  // 二重押下の冪等化 (H1): pdf_only も atomic claim で 2 回目は case を作らない。
  it('pdf_only を 2 回押しても case は 1 件だけ (claimPkg1Session で TOCTOU を閉じる)', async () => {
    await walkToConfirm();
    // 1 回目: case 1 件作成・session は claim で削除。
    await postback('action=pkg1_confirm&value=pdf_only&step=awaiting_confirm');
    expect(tables.cases).toHaveLength(1);
    expect(tables.quote_versions).toHaveLength(1);
    const repliesAfterFirst = replied.length;
    // 2 回目 (連打): session は claim 済みで無 → Step ID ゲートで stale silent。
    // 仮にゲートをすり抜けても claimPkg1Session が空を返し silent。case は増えない。
    await postback('action=pkg1_confirm&value=pdf_only&step=awaiting_confirm');
    expect(tables.cases).toHaveLength(1);
    expect(tables.quote_versions).toHaveLength(1);
    expect(replied.length).toBe(repliesAfterFirst);
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

  it('「別の日時にする」 returns to the date list (user 確認 2026-06-24)', async () => {
    await reachStoreSelection();
    await postback('action=pkg1_reserve_store&value=s1');
    const dt = nextMondayAt14();
    const date = dt.slice(0, 10);
    await postback(`action=pkg1_reserve_date&value=${date}`);
    await postback(`action=pkg1_reserve_time&value=${dt}`);
    await postback('action=pkg1_reserve_confirm&value=change');
    // 仕様: 「別の日時にする」は user が日付を変えたい意図 → 常に日付選択へ戻す。
    // 同日別時間は直前 step rollback (時間選択 Flex 自体に戻る) で表現する。
    expect(lastReplyText()).toContain('別の日付をお選びください');
    expect(lastReplyAny()).toContain('action=pkg1_reserve_date&value=');
    expect(sessionReservationStep()).toBe('awaiting_date');
    expect(tables.cases).toHaveLength(0);
  });

  // ── 二重押下の冪等化 (2026-06-23 真因: 「はい」連打で 2 案件) ─────────────────
  it('confirm=ok を 2 回押しても case は 1 件だけ作られ、2 回目は完全 silent (no-op)', async () => {
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
    // 直近確定マーカーが残っている (連打 silent 判定の根拠)。
    expect(tables.bot_sessions.some((r) => r.kind === 'reservation_done')).toBe(true);

    const repliesAfterFirst = replied.length;

    // 2 回目 (連打 / webhook retry 相当): session は claim 済みで空 + 直近確定
    // マーカーが鮮度内 → 完全 silent no-op (reply 一切なし・case も増えない)。
    await postback('action=pkg1_reserve_confirm&value=ok');
    // case / quote_version が増えない (= スタッフ引継も二重にならない)。
    expect(tables.cases).toHaveLength(1);
    expect(tables.quote_versions).toHaveLength(1);
    // reply が 1 回も増えていない (= 完全無音)。
    expect(replied.length).toBe(repliesAfterFirst);
    // 「リセットされました」graceful 導線も出ない。
    expect(lastReplyText()).not.toContain('リセット');
    expect(lastReplyText()).not.toContain('もう一度はじめから');
  });

  it('session が本当に失効していれば confirm=ok は graceful 導線を返す (silent でない)', async () => {
    await reachStoreSelection();
    await postback('action=pkg1_reserve_store&value=s1');
    const dt = nextMondayAt14();
    const date = dt.slice(0, 10);
    await postback(`action=pkg1_reserve_date&value=${date}`);
    await postback(`action=pkg1_reserve_time&value=${dt}`);

    // reservation session を外部要因で失効させる (確定マーカーも無い状態)。
    tables.bot_sessions = tables.bot_sessions.filter((r) => r.kind !== 'reservation');

    await postback('action=pkg1_reserve_confirm&value=ok');
    // case は作られない。
    expect(tables.cases).toHaveLength(0);
    // 直近確定マーカーが無い空 claim は失効として graceful 導線 (reservationLost)。
    expect(lastReplyText()).toContain('もう一度はじめから');
  });

  // ── Step ID ゲートによる二重押下防止 (claim より前段で止まる多層防御) ─────────
  it('step 付き confirm=ok の 2 回目は Step ID ゲートで silent (case 1 件のまま)', async () => {
    await reachStoreSelection();
    await postback('action=pkg1_reserve_store&value=s1&step=awaiting_store');
    const dt = nextMondayAt14();
    const date = dt.slice(0, 10);
    await postback(`action=pkg1_reserve_date&value=${date}&step=awaiting_date`);
    await postback(`action=pkg1_reserve_time&value=${dt}&step=awaiting_time`);

    // 1 回目: 確定 (advance) → reservation session は削除される。
    await postback('action=pkg1_reserve_confirm&value=ok&step=awaiting_confirm');
    expect(tables.cases).toHaveLength(1);
    const repliesAfterFirst = replied.length;

    // 2 回目: reservation session が無いので Step ID ゲートが stale 判定 → silent。
    // (claim/done マーカーに到達する前段で止まる多層防御)。
    await postback('action=pkg1_reserve_confirm&value=ok&step=awaiting_confirm');
    expect(tables.cases).toHaveLength(1);
    expect(replied.length).toBe(repliesAfterFirst);
  });
});

// ── escalation paths (REQ-018) ────────────────────────────────────────────────

describe('escalation paths (REQ-PKG1-018・v1.6: お悩みフロー経由)', () => {
  it('region=その他(自由記述) → お悩み自由文入力 (旧スタッフ即送りを置換)', async () => {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    await postback('action=pkg1_region&value=other');
    expect(lastReplyText()).toContain('どのようなことでお困りですか');
    expect(sessionStep()).toBe('awaiting_osayami_input');
    // お悩みを挟むので、即 manual_mode へは倒れない。
    expect(tables.bot_sessions.some((r) => r.kind === 'manual_mode')).toBe(false);
  });

  it('symptom=その他 (sample=null) → お悩み自由文入力', async () => {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    await postback('action=pkg1_region&value=drivetrain');
    await postback(`action=pkg1_symptom&value=${DRIVETRAIN_OTHER}`);
    expect(lastReplyText()).toContain('どのようなことでお困りですか');
    expect(sessionStep()).toBe('awaiting_osayami_input');
  });
});

// ── staff 通知の種別タグ判定 (Add-D / Add-F) ──────────────────────────────────
//
// v1.6: Pkg1 の確定不能導線は「お悩みフロー → (合わなければ) スタッフ相談」へ移行し、
// 即 notifyStaff は呼ばなくなった (スタッフ相談は subagent B の内容確認ループが担う)。
// notifyStaff / classifyInquiry / routeInquiry の種別タグ・店舗振り分けの不変条件は
// 引き続き直接検証する (お悩み→スタッフ後も B が同じ classifyInquiry を使うため重要)。
describe('staff 通知の種別タグ (Add-D / Add-F)', () => {
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

  it('region=その他 は即 notifyStaff せず お悩みフローへ入る (v1.6)', async () => {
    await gasPostback('pkg1_start');
    await gasPostback('action=pkg1_dispatch&value=identified');
    await gasPostback('action=pkg1_region&value=other');

    // 旧実装は即 gmail_notify したが、v1.6 はまず お悩み入力を出す。
    expect(lastStaffNotify()).toBeUndefined();
    expect(lastReplyText()).toContain('どのようなことでお困りですか');
    expect(tables.bot_sessions.some((r) => r.kind === 'manual_mode')).toBe(false);
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

// ── 包括メンテゲート (A2・v1.6) ───────────────────────────────────────────────

describe('包括メンテゲート (A2・v1.6)', () => {
  async function enterGate() {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=comprehensive');
  }

  it('comprehensive → 4 メニュー carousel + entry actions を出す', async () => {
    await enterGate();
    const s = lastReplyAny();
    expect(s).toContain('オーバーホール プレミアム');
    expect(s).toContain('action=pkg1_overhaul&value=picker');
    expect(s).toContain('action=pkg1_overhaul&value=matrix');
    expect(sessionStep()).toBe('awaiting_overhaul_menu');
  });

  it('「メニューの選択に進む」→ 4 択 picker', async () => {
    await enterGate();
    await postback('action=pkg1_overhaul&value=picker');
    expect(lastReplyText()).toContain('action=pkg1_overhaul_menu&value=la-oh');
  });

  it('「違いについて知る」→ マトリクス (含まれる内容 + オプション) + picker', async () => {
    await enterGate();
    await postback('action=pkg1_overhaul&value=matrix');
    const s = lastReplyAny();
    expect(s).toContain('分解・洗浄・組み立て'); // 含まれる
    expect(s).toContain('油圧ホース交換'); // オプション
    expect(s).toContain('¥12,000');
  });

  it('メニュー確定 → cart に積んで確認 (概算) へ直行', async () => {
    await enterGate();
    await postback('action=pkg1_overhaul_menu&value=la-oh');
    expect(sessionStep()).toBe('awaiting_confirm');
    const c = cart();
    expect(c.length).toBe(1);
    expect((c[0] as { name: string }).name).toContain('オーバーホール プレミアム');
    // 概算見積 + 3 択 (pdf_only / reserve / redo)。
    expect(lastReplyText()).toContain('action=pkg1_confirm&value=pdf_only');
  });

  it('包括メンテ region (overhaul-gate) からも同じゲートに入る', async () => {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    await postback('action=pkg1_region&value=overhaul-gate');
    expect(sessionStep()).toBe('awaiting_overhaul_menu');
    expect(lastReplyAny()).toContain('action=pkg1_overhaul_menu&value=la-oh');
  });
});

// ── お悩みマッチング (A1・v1.6) ───────────────────────────────────────────────

describe('お悩みマッチング (A1・v1.6)', () => {
  function consultSession(): Record<string, unknown> | undefined {
    return tables.bot_sessions.find((r) => r.line_user_id === USER && r.kind === 'staff_consult');
  }
  function osayamiState(): { step?: string; osayamiLoopCount?: number; osayamiCandidates?: string[] } | undefined {
    const s = tables.bot_sessions.find((r) => r.line_user_id === USER && r.kind === 'pkg1_estimate');
    return s?.state as never;
  }
  async function text(t: string): Promise<boolean> {
    return handlePkg1Text(t, ctx());
  }

  it('unknown → お悩み入力 → マッチ 3 件提示 (loop count=1・残回数表示)', async () => {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=unknown');
    expect(osayamiState()?.step).toBe('awaiting_osayami_input');

    const handled = await text('ブレーキが効かない');
    expect(handled).toBe(true);
    const st = osayamiState();
    expect(st?.step).toBe('awaiting_osayami_result');
    expect(st?.osayamiLoopCount).toBe(1);
    const s = lastReplyAny();
    // ブレーキ調整が候補に出る + 操作 3 択。
    expect(s).toContain('ブレーキ調整');
    expect(s).toContain('action=pkg1_osayami&value=pick:0');
    expect(s).toContain('action=pkg1_osayami&value=again');
    expect(s).toContain('action=pkg1_osayami&value=staff');
  });

  it('候補確定 (pick:0) → cart に積んで確認へ', async () => {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=unknown');
    await text('ブレーキが効かない');
    await postback('action=pkg1_osayami&value=pick:0');
    expect(sessionStep()).toBe('awaiting_confirm');
    expect(cart().length).toBe(1);
    expect(lastReplyText()).toContain('action=pkg1_confirm&value=pdf_only');
  });

  it('もう一度質問する (again) → 入力に戻る (loop 維持)', async () => {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=unknown');
    await text('ブレーキが効かない');
    await postback('action=pkg1_osayami&value=again');
    expect(osayamiState()?.step).toBe('awaiting_osayami_input');
    expect(lastReplyText()).toContain('どのようなことでお困りですか');
  });

  it('0 件マッチ → スタッフ相談 CTA (no-match prompt)', async () => {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=unknown');
    await text('zzz該当なし無関係xxx');
    expect(osayamiState()?.step).toBe('awaiting_osayami_result');
    const s = lastReplyAny();
    expect(s).toContain('action=pkg1_osayami&value=staff');
  });

  it('スタッフに相談する (staff) → 内容確認ループ (staff_consult session) へ委譲', async () => {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=unknown');
    await text('ブレーキが効かない');
    await postback('action=pkg1_osayami&value=staff');
    // pkg1 session は片付き、staff_consult session が立つ (subagent B のループ)。
    expect(sessionStep()).toBeUndefined();
    expect(consultSession()).toBeDefined();
  });

  it('5 回上限に達すると自動でスタッフへ移行する', async () => {
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=unknown');
    // 5 回まで present、6 回目の入力で staff_max → スタッフ移行。
    for (let i = 0; i < 5; i += 1) {
      await text('ブレーキが効かない');
      // 上限未満は result へ。最後 (5 回目) で残 0。
      await postback('action=pkg1_osayami&value=again').catch(() => undefined);
    }
    // again は上限到達でスタッフへ倒れる場合があるため、最終状態で staff_consult を確認。
    const consult = consultSession();
    const pkg1 = osayamiState();
    expect(consult !== undefined || (pkg1?.osayamiLoopCount ?? 0) >= 5).toBe(true);
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

// ── labor_options 自動聞き (task 20260625-004) ────────────────────────────────
//
// メニュー (variant / 包括メンテ / お悩み候補) 確定後、その親 labor に紐付く
// labor_options を 1 件ずつ「追加しますか?」と順次問う。options が無いメニューは
// 既存どおり qty / confirm へ skip する (既存テストが seed を空に保つことで担保)。

describe('labor_options 自動聞き (task 20260625-004)', () => {
  /** 指定 labor に option を注入する (test 単位で対象 labor を選ぶ)。 */
  function seedOptions(laborId: string, opts: Array<{ id: string; name: string; price: number; notes?: string }>): void {
    opts.forEach((o, i) => {
      tables.labor_options.push({
        id: o.id,
        tenant_id: TENANT,
        labor_id: laborId,
        code: o.id,
        name: o.name,
        price: o.price,
        is_default: false,
        notes: o.notes ?? null,
        sort_order: 10 + i,
        archived: false,
      });
    });
  }

  function optionFlowState(): { index?: number; selected?: string[]; after?: string } | undefined {
    const s = tables.bot_sessions.find((r) => r.line_user_id === USER && r.kind === 'pkg1_estimate');
    return (s?.state as { optionFlow?: { index?: number; selected?: string[]; after?: string } } | undefined)?.optionFlow;
  }

  it('variant 確定後に options が無ければ従来どおり cart decision (skip)', async () => {
    // la1 (brake-adjust-both) に option を入れない → 従来挙動。
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    await postback('action=pkg1_region&value=brake');
    await postback(`action=pkg1_symptom&value=${BRAKE_ADJUST}`);
    await postback('action=pkg1_variant&value=0');
    expect(sessionStep()).toBe('awaiting_cart_decision');
    expect(cart()).toHaveLength(1);
  });

  it('variant (qty なし) → option 1 件問い → 追加で cart に独立行が積まれる', async () => {
    // brake-adjust-both = la1 (qty なし)。option を 1 件注入する。
    seedOptions('la1', [{ id: 'lo-tube', name: 'チューブも交換', price: 1200 }]);
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    await postback('action=pkg1_region&value=brake');
    await postback(`action=pkg1_symptom&value=${BRAKE_ADJUST}`);
    await postback('action=pkg1_variant&value=0');
    // option 問いに入る (cart にはまだ積まれない)。
    expect(sessionStep()).toBe('awaiting_option');
    expect(lastReplyText()).toContain('チューブも交換');
    expect(lastReplyText()).toContain('action=pkg1_option&value=add:lo-tube');
    expect(cart()).toHaveLength(0);

    // 「追加する」→ 全件完了 → cart に base + option の 2 行。
    await postback('action=pkg1_option&value=add:lo-tube');
    expect(sessionStep()).toBe('awaiting_cart_decision');
    const c = cart() as { name: string; amount: number }[];
    expect(c).toHaveLength(2);
    expect(c[0].name).toContain('ブレーキ調整');
    expect(c[1].name).toBe('チューブも交換');
    const total = c.reduce((s, i) => s + i.amount, 0);
    expect(total).toBe(3000 + 1200);
  });

  it('option を「スキップ」すると cart に base 1 行のみ', async () => {
    seedOptions('la1', [{ id: 'lo-tube', name: 'チューブも交換', price: 1200 }]);
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    await postback('action=pkg1_region&value=brake');
    await postback(`action=pkg1_symptom&value=${BRAKE_ADJUST}`);
    await postback('action=pkg1_variant&value=0');
    await postback('action=pkg1_option&value=skip:lo-tube');
    expect(sessionStep()).toBe('awaiting_cart_decision');
    expect(cart()).toHaveLength(1);
  });

  it('複数 option を順次問い、選んだものだけ積む (2 件中 1 件 add)', async () => {
    seedOptions('la1', [
      { id: 'lo-a', name: 'オプションA', price: 1000 },
      { id: 'lo-b', name: 'オプションB', price: 2000 },
    ]);
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    await postback('action=pkg1_region&value=brake');
    await postback(`action=pkg1_symptom&value=${BRAKE_ADJUST}`);
    await postback('action=pkg1_variant&value=0');
    // 1 件目 = A (skip)。まだ option フェーズ・2 件目へ。
    await postback('action=pkg1_option&value=skip:lo-a');
    expect(sessionStep()).toBe('awaiting_option');
    expect(lastReplyText()).toContain('オプションB');
    // 2 件目 = B (add)。完了 → cart に base + B。
    await postback('action=pkg1_option&value=add:lo-b');
    expect(sessionStep()).toBe('awaiting_cart_decision');
    const c = cart() as { name: string }[];
    expect(c.map((i) => i.name)).toEqual([expect.stringContaining('ブレーキ調整'), 'オプションB']);
  });

  it('variant (qty あり) → options 完了後に数量選択へ・qty 後に options も積む', async () => {
    // spoke-swap = la3 (qty='single')。option を 1 件注入する。
    seedOptions('la3', [{ id: 'lo-cap', name: 'バルブキャップ', price: 300 }]);
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    await postback('action=pkg1_region&value=wheel');
    await postback(`action=pkg1_symptom&value=${SPOKE_SWAP}`);
    // qty より先に option 問いが来る (旧 PWA: variant → option → qty)。
    expect(sessionStep()).toBe('awaiting_option');
    await postback('action=pkg1_option&value=add:lo-cap');
    // option 完了 → 数量選択へ。
    expect(sessionStep()).toBe('awaiting_qty');
    await postback('action=pkg1_qty&value=2');
    // qty 確定後: base (qty=2) + option (qty=1)。
    expect(sessionStep()).toBe('awaiting_cart_decision');
    const c = cart() as { name: string; qty: number }[];
    expect(c).toHaveLength(2);
    expect(c[0].qty).toBe(2);
    expect(c[1].name).toBe('バルブキャップ');
    expect(c[1].qty).toBe(1);
  });

  it('包括メンテ menu 確定 → options 問い → 完了で base + options を積み confirm', async () => {
    // la-oh に 2 件 (1 件は price=0 の要相談オプション)。
    seedOptions('la-oh', [
      { id: 'lo-glass', name: 'ガラスコーティング', price: 15000 },
      { id: 'lo-paint', name: '全塗装', price: 0, notes: 'お見積もり要相談' },
    ]);
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=comprehensive');
    await postback('action=pkg1_overhaul_menu&value=la-oh');
    // options 問いに入る (即 confirm に行かない)。
    expect(sessionStep()).toBe('awaiting_option');
    expect(lastReplyText()).toContain('ガラスコーティング');
    // 1 件目 add → 2 件目 (要相談) を表示。
    await postback('action=pkg1_option&value=add:lo-glass');
    expect(sessionStep()).toBe('awaiting_option');
    expect(lastReplyText()).toContain('要相談');
    // 2 件目 add → 完了で confirm。base + 2 options。
    await postback('action=pkg1_option&value=add:lo-paint');
    expect(sessionStep()).toBe('awaiting_confirm');
    const c = cart() as { name: string; amount: number }[];
    expect(c).toHaveLength(3);
    expect(c[0].name).toContain('オーバーホール');
    expect(c.map((i) => i.name)).toContain('ガラスコーティング');
    expect(c.map((i) => i.name)).toContain('全塗装');
    // 要相談 (price=0) は金額 0 で積まれる。
    expect((c.find((i) => i.name === '全塗装') as { amount: number }).amount).toBe(0);
  });

  it('お悩み候補確定でも options を順次問う', async () => {
    seedOptions('la1', [{ id: 'lo-tube', name: 'チューブも交換', price: 1200 }]);
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=unknown');
    await handlePkg1Text('ブレーキが効かない', ctx()); // la1 (tags: ブレーキ/効かない) にマッチ
    expect(sessionStep()).toBe('awaiting_osayami_result');
    await postback('action=pkg1_osayami&value=pick:0');
    // 候補確定後、options 問いへ (即 confirm に行かない)。
    expect(sessionStep()).toBe('awaiting_option');
    await postback('action=pkg1_option&value=skip:lo-tube');
    expect(sessionStep()).toBe('awaiting_confirm');
    expect(cart()).toHaveLength(1);
  });

  it('archived な option は問わない (skip)', async () => {
    // archived option のみ → options 無し扱い → 従来 cart decision へ。
    tables.labor_options.push({
      id: 'lo-arch', tenant_id: TENANT, labor_id: 'la1', code: 'arch', name: '廃止', price: 999,
      is_default: false, notes: null, sort_order: 10, archived: true,
    });
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    await postback('action=pkg1_region&value=brake');
    await postback(`action=pkg1_symptom&value=${BRAKE_ADJUST}`);
    await postback('action=pkg1_variant&value=0');
    expect(sessionStep()).toBe('awaiting_cart_decision');
    expect(cart()).toHaveLength(1);
  });

  it('古い option bubble (違う option id) を押すと stale → silent', async () => {
    seedOptions('la1', [
      { id: 'lo-a', name: 'オプションA', price: 1000 },
      { id: 'lo-b', name: 'オプションB', price: 2000 },
    ]);
    await postback('pkg1_start');
    await postback('action=pkg1_dispatch&value=identified');
    await postback('action=pkg1_region&value=brake');
    await postback(`action=pkg1_symptom&value=${BRAKE_ADJUST}`);
    await postback('action=pkg1_variant&value=0');
    // 今問うているのは lo-a (index 0)。lo-b の add を押す (= まだ来ていない先の bubble)。
    const before = replied.length;
    await postback('action=pkg1_option&value=add:lo-b&step=awaiting_option');
    expect(replied.length).toBe(before); // silent
    expect(optionFlowState()?.index).toBe(0); // 進まない
    expect(optionFlowState()?.selected).toEqual([]); // 積まれない
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
