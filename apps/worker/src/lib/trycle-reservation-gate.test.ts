/**
 * 各種予約 3 分岐 + 来店予定ゲート (Phase 4) — state machine tests。
 *
 * Supabase REST は in-memory モック (bot_sessions / stores / case_statuses / cases /
 * customers / tenants)。LineClient はキャプチャ用 stub。pkg1.test.ts の mock seam
 * (vi.stubGlobal('fetch', supabaseMock)) を流用する。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handleReservationGatePostback,
  handleReservationGateText,
  isReservationPostback,
} from './trycle-reservation-gate.js';
import { tryHandleTryclePostback } from './trycle-postback.js';
import type { Env } from '../index.js';

const USER = 'U-test';
const TENANT = 't-1';

// ── in-memory Supabase ───────────────────────────────────────────────────────

interface Tables {
  bot_sessions: Record<string, unknown>[];
  stores: Record<string, unknown>[];
  case_statuses: Record<string, unknown>[];
  cases: Record<string, unknown>[];
  customers: Record<string, unknown>[];
  tenants: Record<string, unknown>[];
}

let tables: Tables;
let idSeq = 0;

function resetTables(twoStores = true): void {
  const stores: Record<string, unknown>[] = [
    {
      id: 's1',
      tenant_id: TENANT,
      name: '矢野口本店',
      code: 'Y',
      business_hours: {
        mon: ['10:00', '19:00'],
        tue: ['10:00', '19:00'],
        wed: ['10:00', '19:00'],
        thu: ['10:00', '19:00'],
        fri: ['10:00', '19:00'],
        sat: ['10:00', '19:00'],
        sun: ['10:00', '19:00'],
      },
      reservation_slot_minutes: 30,
      is_active: true,
      sort_order: 0,
      default_assignee_id: 'u-staff-1',
    },
  ];
  if (twoStores) {
    stores.push({
      id: 's2',
      tenant_id: TENANT,
      name: '宮ヶ瀬店',
      code: 'M',
      business_hours: {
        mon: ['10:00', '19:00'],
        tue: ['10:00', '19:00'],
        wed: ['10:00', '19:00'],
        thu: ['10:00', '19:00'],
        fri: ['10:00', '19:00'],
        sat: ['10:00', '19:00'],
        sun: ['10:00', '19:00'],
      },
      reservation_slot_minutes: 30,
      is_active: true,
      sort_order: 1,
      default_assignee_id: null,
    });
  }
  tables = {
    bot_sessions: [],
    stores,
    case_statuses: [
      { id: 'st-new', tenant_id: TENANT, key: 'quote', label: '見積のみ', sort_order: 1 },
      { id: 'st-booked', tenant_id: TENANT, key: 'booked', label: '予約済', sort_order: 3 },
    ],
    cases: [],
    customers: [{ id: 'c1', tenant_id: TENANT, name: '山田太郎', phone: '090', line_user_id: USER }],
    tenants: [{ id: TENANT, settings: { storesUrl: 'https://trycle.stores.jp' } }],
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
    const matched = rows.filter((r) => matchRow(r, parseFilters(url)));
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
      return new Response(JSON.stringify(removed), { status: 200 });
    }
    return new Response(null, { status: 204 });
  }
  if (method === 'PATCH') {
    const filters = parseFilters(url);
    const patch = JSON.parse((init!.body as string) ?? '{}') as Record<string, unknown>;
    for (const r of rows) if (matchRow(r, filters)) Object.assign(r, patch);
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

/** recordOutgoingMessages 用の最小 D1 stub (friend 解決で空を返し no-op になる)。 */
const dbStub = {
  prepare: () => ({
    bind: () => ({
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => undefined,
    }),
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => undefined,
  }),
} as unknown as D1Database;

function env(): Env['Bindings'] {
  return {
    SUPABASE_URL: 'https://sb.example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
    TRYCLE_TENANT_ID: TENANT,
    DB: dbStub,
    // GAS / Gmail / LIFF は未設定で graceful degrade を効かせる。
  } as Env['Bindings'];
}

function ctx() {
  return { replyToken: `rt-${Math.random()}`, lineUserId: USER, lineClient, env: env() };
}

async function postback(data: string): Promise<boolean> {
  return handleReservationGatePostback(data, ctx());
}

function allReplies(): string {
  return JSON.stringify(replied);
}

function visitSession(): Record<string, unknown> | undefined {
  return tables.bot_sessions.find((r) => r.line_user_id === USER && r.kind === 'visit_gate');
}

function visitStep(): string | undefined {
  return (visitSession()?.state as { step?: string } | undefined)?.step;
}

/** session に step を埋めた postback data を作る (Step ID ゲートを通すため)。 */
function withStep(data: string): string {
  const step = visitStep();
  return step ? `${data}&step=${step}` : data;
}

beforeEach(() => {
  resetTables();
  replied = [];
  pushed = [];
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', vi.fn(supabaseMock));
});

// ── 判定 ────────────────────────────────────────────────────────────────────

describe('isReservationPostback', () => {
  it('reservation_* を検出する', () => {
    expect(isReservationPostback('action=reservation_start')).toBe(true);
    expect(isReservationPostback('action=reservation_visit_confirm&value=ok')).toBe(true);
  });
  it('pkg1_ / 無関係は false', () => {
    expect(isReservationPostback('pkg1_start')).toBe(false);
    expect(isReservationPostback('faq_start')).toBe(false);
  });
});

// ── ① 3 分岐メニュー ─────────────────────────────────────────────────────────

describe('reservation_start', () => {
  it('3 択 Flex を返す', async () => {
    const handled = await postback('action=reservation_start');
    expect(handled).toBe(true);
    const json = allReplies();
    expect(json).toContain('各種予約');
    expect(json).toContain('action=reservation_stores');
    expect(json).toContain('action=reservation_maintenance');
    expect(json).toContain('action=reservation_visit_start');
  });
});

// ── ② STORES リンク ───────────────────────────────────────────────────────────

describe('reservation_stores', () => {
  it('tenants.settings.storesUrl の URI ボタンを返す', async () => {
    await postback('action=reservation_stores');
    const json = allReplies();
    expect(json).toContain('https://trycle.stores.jp');
    expect(json).toContain('uri');
  });

  it('storesUrl 未設定なら fail-loud (URI を出さない)', async () => {
    tables.tenants[0].settings = {};
    await postback('action=reservation_stores');
    const json = allReplies();
    expect(json).toContain('準備中');
    expect(json).not.toContain('"uri"');
  });

  it('env TRYCLE_STORES_URL を fallback に使う', async () => {
    tables.tenants[0].settings = {};
    const e = { ...env(), TRYCLE_STORES_URL: 'https://env.stores.jp' } as Env['Bindings'];
    await handleReservationGatePostback('action=reservation_stores', {
      replyToken: 'rt', lineUserId: USER, lineClient, env: e,
    });
    expect(allReplies()).toContain('https://env.stores.jp');
  });
});

// ── ③ メンテナンス → Pkg1 橋渡し (dispatcher 経由) ────────────────────────────

describe('reservation_maintenance (dispatcher 経由で Pkg1 へ)', () => {
  it('pkg1_start を発火し状況ふりわけを出す', async () => {
    const handled = await tryHandleTryclePostback('action=reservation_maintenance', {
      replyToken: 'rt', lineUserId: USER, lineClient, env: env(),
    });
    expect(handled).toBe(true);
    // Pkg1 startFlow は「状況に近いもの」3 択を出す。
    expect(allReplies()).toContain('pkg1_dispatch');
  });
});

// ── ④ 来店予定ゲート フロー ────────────────────────────────────────────────────

describe('来店予定ゲート', () => {
  it('その他 → 自由文 prompt (skip ボタン付き) を出し session を開始', async () => {
    await postback('action=reservation_visit_start');
    expect(visitStep()).toBe('awaiting_inquiry');
    expect(allReplies()).toContain('action=reservation_visit_skip');
  });

  it('複数店舗: 自由文入力 → 店舗選択へ進む', async () => {
    await postback('action=reservation_visit_start');
    const handled = await handleReservationGateText('ロードバイクを買いたい', ctx());
    expect(handled).toBe(true);
    expect(visitStep()).toBe('awaiting_store');
    expect(allReplies()).toContain('action=reservation_visit_store');
    // 自由文が session に保持される。
    expect((visitSession()!.state as { inquiry?: string }).inquiry).toBe('ロードバイクを買いたい');
  });

  it('1 店舗運用: 店舗選択を skip して日付選択へ直行', async () => {
    resetTables(false); // 1 店舗のみ
    await postback('action=reservation_visit_start');
    await handleReservationGateText('相談したい', ctx());
    expect(visitStep()).toBe('awaiting_date');
    const s = visitSession()!.state as { storeId?: string };
    expect(s.storeId).toBe('s1');
    expect(allReplies()).toContain('action=reservation_visit_date');
  });

  it('skip ボタンで内容未指定のまま進む', async () => {
    await postback('action=reservation_visit_start');
    await postback('action=reservation_visit_skip');
    expect(visitStep()).toBe('awaiting_store');
    expect((visitSession()!.state as { inquiry?: string }).inquiry).toBeUndefined();
  });

  it('店舗 → 日付 → 時間 → 確認 → 予約する で case を 1 件作成', async () => {
    await postback('action=reservation_visit_start');
    await handleReservationGateText('購入相談', ctx());
    // 店舗選択
    await postback(withStep('action=reservation_visit_store&value=s1'));
    expect(visitStep()).toBe('awaiting_date');
    // 日付選択 (候補から 1 件取り出す)
    const dateData = extractData('reservation_visit_date');
    expect(dateData).toBeTruthy();
    await postback(withStep(dateData!));
    expect(visitStep()).toBe('awaiting_time');
    // 時間選択
    const timeData = extractData('reservation_visit_time');
    expect(timeData).toBeTruthy();
    await postback(withStep(timeData!));
    expect(visitStep()).toBe('awaiting_confirm');
    expect(allReplies()).toContain('action=reservation_visit_confirm');
    // 確認内容に相談内容が出る
    expect(allReplies()).toContain('購入相談');

    // 予約する
    const before = tables.cases.length;
    await postback(withStep('action=reservation_visit_confirm&value=ok'));
    expect(tables.cases.length).toBe(before + 1);
    const created = tables.cases.at(-1)!;
    expect(created.status_id).toBe('st-booked');
    expect(created.assignee_id).toBe('u-staff-1'); // store default assignee
    expect(created.visit_scheduled_at).toContain('+09:00');
    expect(created.work_note).toContain('来店予定');
    // session は claim で消える
    expect(visitSession()).toBeUndefined();
    // 完了文言
    expect(allReplies()).toContain('ご予約を承りました');
  });

  it('予約する の二重押下で case は 1 件のみ (claim 冪等)', async () => {
    await runToConfirm();
    const confirmData = withStep('action=reservation_visit_confirm&value=ok');
    const before = tables.cases.length;
    await postback(confirmData);
    await postback(confirmData); // 2 回目 (session は既に claim 済み)
    expect(tables.cases.length).toBe(before + 1);
  });

  it('日時を変更する で日付選択へ戻る', async () => {
    await runToConfirm();
    await postback(withStep('action=reservation_visit_confirm&value=change'));
    expect(visitStep()).toBe('awaiting_date');
    expect(allReplies()).toContain('別の日付');
  });

  it('Step ID 不一致 (2 手以上前の古ボタン) は silent no-op', async () => {
    await postback('action=reservation_visit_start');
    await handleReservationGateText('相談', ctx());
    await postback(withStep('action=reservation_visit_store&value=s1'));
    // いま awaiting_date (previous=awaiting_store)。2 手以上前の step を持つ古ボタン
    // (step=awaiting_inquiry) は current でも previous でもないため stale。
    replied = [];
    const handled = await postback('action=reservation_visit_date&value=2099-01-01&step=awaiting_inquiry');
    expect(handled).toBe(true);
    expect(replied.length).toBe(0); // 完全 silent
    expect(visitStep()).toBe('awaiting_date'); // 進行は変わらない
  });

  it('session 失効中の確定は graceful 導線 (3 択再提示)', async () => {
    // session なしでいきなり confirm。
    const handled = await postback('action=reservation_visit_confirm&value=ok&step=awaiting_confirm');
    expect(handled).toBe(true);
    // claim 空 → silent (重複防止優先)。case も作られない。
    expect(tables.cases.length).toBe(0);
  });
});

// ── inquiry text は active gate session が無ければ通さない ─────────────────────

describe('handleReservationGateText', () => {
  it('active な visit_gate session が無ければ false (後続 handler へ流す)', async () => {
    const handled = await handleReservationGateText('適当なテキスト', ctx());
    expect(handled).toBe(false);
  });
});

// ── helpers ────────────────────────────────────────────────────────────────────

/** 直近の reply 群から指定 action を含む postback data を 1 件取り出す。 */
function extractData(action: string): string | null {
  const json = JSON.stringify(replied.at(-1) ?? []);
  const re = new RegExp(`"data":"(action=${action}[^"]*)"`);
  const m = json.match(re);
  return m ? m[1].replace(/&step=[^&"]*/, '') : null;
}

/** その他 → 店舗 → 日付 → 時間 まで進めて awaiting_confirm にする。 */
async function runToConfirm(): Promise<void> {
  await postback('action=reservation_visit_start');
  await handleReservationGateText('購入相談', ctx());
  await postback(withStep('action=reservation_visit_store&value=s1'));
  await postback(withStep(extractData('reservation_visit_date')!));
  await postback(withStep(extractData('reservation_visit_time')!));
}
