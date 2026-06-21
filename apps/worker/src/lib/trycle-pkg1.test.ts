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
    tables[table] = rows.filter((r) => !matchRow(r, filters));
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

function sessionStep(): string | undefined {
  const s = tables.bot_sessions.find(
    (r) => r.line_user_id === USER && r.kind === 'pkg1_estimate',
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
    expect(isPkg1Postback('action=pkg1_reserve_slot&value=s1|2026-06-22t14:00')).toBe(true);
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

  it('同意済なら同意書をスキップして来店日時候補の縦リストに進む', async () => {
    tables.consents.push({
      tenant_id: TENANT,
      line_user_id: USER,
      source: 'maintenance-consent',
      consented_at: new Date().toISOString(),
    });
    await walkToConfirm();
    await postback('action=pkg1_confirm&value=reserve');
    expect(lastReplyText()).toContain('ご来店予定の日時をお選びください');
    // 候補は店舗を内包した postback で出る。
    expect(lastReplyAny()).toContain('action=pkg1_reserve_slot&value=s1|');
    const reservation = tables.bot_sessions.find((r) => r.kind === 'reservation');
    expect((reservation?.state as { step?: string })?.step).toBe('awaiting_reservation_slot');
  });
});

// ── 来店予定: Option A 日時候補 縦リスト → 確認 → 完了 (cases + quote_versions) ──

describe('reservation flow (日時候補 縦リスト → 確認)', () => {
  async function reachSlotSelection() {
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

  it('shows a store-internalized slot list directly after 来店予定 (no store step)', async () => {
    await reachSlotSelection();
    const s = lastReplyAny();
    // 旧 store carousel postback は出ない。
    expect(s).not.toContain('pkg1_reserve_store');
    // 候補は両店舗ぶん出る (矢野口=s1・宮ヶ瀬=s2 は business_hours 空なので候補ゼロ → s1 のみ)。
    expect(s).toContain('action=pkg1_reserve_slot&value=s1|');
  });

  it('walks slot → confirm → ok and saves a 来店予定 case', async () => {
    await reachSlotSelection();
    // 矢野口は毎日 10:00-19:00・30分刻み。次の月曜 14:00 は 14 日窓内の有効候補。
    const dt = nextMondayAt14();
    await postback(`action=pkg1_reserve_slot&value=s1|${dt}`);
    expect(lastReplyText()).toContain('来店予定でよろしいですか');
    await postback('action=pkg1_reserve_confirm&value=ok');
    expect(lastReplyText()).toContain('お待ちしております');
    expect(tables.cases).toHaveLength(1);
    expect(tables.cases[0].work_note).toBe('来店予定');
    expect(tables.cases[0].visit_scheduled_at).toBe(dt);
    expect(tables.quote_versions).toHaveLength(1);
    // reservation session is cleared
    expect(tables.bot_sessions.some((r) => r.kind === 'reservation')).toBe(false);
  });

  it('re-offers the slot list when a stale/invalid slot value is tapped (二重チェック)', async () => {
    await reachSlotSelection();
    // 03:00 は営業時間外。候補からは出ないが、stale な値が来ても無反応にせず再提示する。
    await postback('action=pkg1_reserve_slot&value=s1|2026-06-22t03:00');
    expect(lastReplyText()).toContain('別の日時をお選びください');
    expect(tables.cases).toHaveLength(0);
  });

  it('「別の日時にする」 re-offers the slot list and keeps the reservation session', async () => {
    await reachSlotSelection();
    const dt = nextMondayAt14();
    await postback(`action=pkg1_reserve_slot&value=s1|${dt}`);
    await postback('action=pkg1_reserve_confirm&value=change');
    expect(lastReplyText()).toContain('別の日時をお選びください');
    expect(lastReplyAny()).toContain('action=pkg1_reserve_slot&value=s1|');
    expect(tables.cases).toHaveLength(0);
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
