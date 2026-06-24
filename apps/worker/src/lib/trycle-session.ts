/**
 * TRYCLE Pkg1 session state (bot_sessions) + 有人モード (manual_mode) helpers.
 *
 * 設計: Pkg1 詳細設計 v1.2.1 §4 / §7 (page 386050ad6a7e81f8b701cd52c9201af6)。
 * モデルは本物 trycle-line-harness/src/flows/pkg1-estimate.ts の `Pkg1Session` /
 * `Pkg1Step` に揃える (region→symptom→variant→qty→cart の症状ヒアリング)。
 *
 * - `bot_sessions` (Supabase・migration 0016) は **bot ロジックの作業メモ** =
 *   step / cart / pending の状態スナップショットを保持する。
 *   会話履歴ではない (履歴は LH 標準 messages_log = D1 が正本)。
 * - kind='pkg1_estimate' = 見積フローの作業状態。
 * - kind='pkg1_cart'     = 同意書未取得時の cart 永続化 (callback 復帰用・経路 D-2)。
 * - kind='reservation'   = 来店予定フロー (別 session・本物 ReservationStep)。
 * - kind='manual_mode'   = 有人切替フラグ (REQ-PKG1-024)。LH §9 Inbox に
 *   標準の bot 抑止機構は無いため (catalog grep 確認済) bot_sessions で実装する。
 *
 * UNIQUE (tenant_id, line_user_id, kind) なので 1 ユーザー : 1 active session/kind。
 */
import {
  supabaseSelect,
  supabaseUpsert,
  supabaseDelete,
  supabaseDeleteReturning,
  type SupabaseEnvLike,
} from './supabase.js';
import { getTenantId, type TrycleRepoEnv } from './trycle-repo.js';
import type { QuoteLineItem } from './quote.js';

export const PKG1_SESSION_KIND = 'pkg1_estimate';
export const PKG1_CART_KIND = 'pkg1_cart';
export const RESERVATION_KIND = 'reservation';
export const MANUAL_MODE_KIND = 'manual_mode';
/**
 * 来店予定が「直近で確定済み」かを残す短命マーカー (連打の 2 回目を完全 silent に
 * するため・2026-06-23 真因 II)。finalize 成功時に confirmed_at を書き、確認 Flex
 * の 2 回目タップが空 claim になったとき「直近確定の重複」か「session 失効」かを
 * これで区別する。state.confirmed_at に ISO timestamp を持つ。
 */
export const RESERVATION_DONE_KIND = 'reservation_done';

/** 24 時間無操作で stale 扱い (設計 §7 session ライフサイクル)。 */
export const SESSION_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * 連打を「重複」と見なす時間窓 (この窓内の 2 回目以降は完全 silent no-op)。
 * 窓を超えた空 claim は本当の session 失効として graceful 導線へ倒す。
 */
export const RECENT_CONFIRM_WINDOW_MS = 30 * 1000;

/** 本物 `Pkg1Step` (pkg1-estimate.ts) に揃える (CRITICAL #5・設計 v1.2.1 §4)。 */
export type Pkg1Step =
  | 'awaiting_dispatch'
  | 'awaiting_region'
  | 'awaiting_symptom'
  | 'awaiting_variant'
  | 'awaiting_qty'
  | 'awaiting_cart_decision'
  | 'awaiting_confirm'
  | 'awaiting_consent_form'
  | 'completed';

/** 選択途中保持 (本物 `PendingSelection`)。region/symptom/variant は index 参照。 */
export interface PendingSelection {
  readonly regionValue: string;
  readonly symptomIndex: number;
  readonly variantIndex?: number;
}

/**
 * Pkg1 セッション state。cart は本物 `QuoteLineItem[]` (name/unitPrice/qty/amount …)。
 * variant ラベル・open-ended の「〜」は name に埋め込む (buildLineItemFromPending)。
 */
export interface Pkg1State {
  readonly step: Pkg1Step;
  readonly cart: QuoteLineItem[];
  readonly pending?: PendingSelection;
}

interface BotSessionRow {
  readonly state: Pkg1State;
  readonly updated_at: string;
}

/**
 * 来店予定フロー state (経路 D-2)。別 kind の session。
 *
 * 3 段階フロー (店舗 → 日付 → 時間 → 確認)。Option A の単一 carousel は 287 候補で
 * 168KB → LINE Flex 50KB 上限超過で Push が reject される事故の原因だったため、各画面を
 * 軽量に保てる 3 段階に分解した。`date` は YYYY-MM-DD・`visitAtIso` は YYYY-MM-DDtHH:mm。
 */
export type ReservationStep =
  | 'awaiting_store'
  | 'awaiting_date'
  | 'awaiting_time'
  | 'awaiting_confirm'
  | 'completed';

export interface ReservationState {
  readonly step: ReservationStep;
  readonly cart: QuoteLineItem[];
  readonly storeId?: string;
  readonly storeName?: string;
  /** "YYYY-MM-DD" (選択した来店日)。 */
  readonly date?: string;
  /** "YYYY-MM-DDtHH:mm" (選択した来店日時)。 */
  readonly visitAtIso?: string;
}

/** 空の Pkg1 セッション初期値 (本物 startFlow: awaiting_dispatch + 空 cart)。 */
export function emptyPkg1State(): Pkg1State {
  return { step: 'awaiting_dispatch', cart: [] };
}

/**
 * Pkg1 セッションを取得する。stale (24h 超) または未存在なら null。
 */
export async function getPkg1Session(
  env: TrycleRepoEnv,
  lineUserId: string,
  now: Date = new Date(),
): Promise<Pkg1State | null> {
  const rows = await supabaseSelect<BotSessionRow>(
    env,
    'bot_sessions',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      line_user_id: `eq.${lineUserId}`,
      kind: `eq.${PKG1_SESSION_KIND}`,
    },
    { select: 'state,updated_at', limit: 1 },
  );
  const row = rows[0];
  if (!row) return null;
  const updatedAt = new Date(row.updated_at);
  if (now.getTime() - updatedAt.getTime() > SESSION_STALE_MS) {
    return null;
  }
  return normalizeState(row.state);
}

/** Pkg1 セッションを UPSERT する (state を丸ごと上書き)。 */
export async function upsertPkg1Session(
  env: TrycleRepoEnv,
  lineUserId: string,
  state: Pkg1State,
): Promise<void> {
  await supabaseUpsert(
    env,
    'bot_sessions',
    [
      {
        tenant_id: getTenantId(env),
        line_user_id: lineUserId,
        kind: PKG1_SESSION_KIND,
        state,
        updated_at: new Date().toISOString(),
      },
    ],
    { onConflict: 'tenant_id,line_user_id,kind' },
  );
}

/** Pkg1 セッションを削除する (フロー完了・リセット時)。 */
export async function clearPkg1Session(
  env: TrycleRepoEnv,
  lineUserId: string,
): Promise<void> {
  await supabaseDelete(env, 'bot_sessions', {
    tenant_id: `eq.${getTenantId(env)}`,
    line_user_id: `eq.${lineUserId}`,
    kind: `eq.${PKG1_SESSION_KIND}`,
  });
}

// ── pkg1_cart (同意書未取得時の cart 永続化・経路 D-2) ─────────────────────────

/**
 * 未同意で来店予定に進んだ user の cart を永続化する (本物 enterReservation)。
 * 同意書 callback (別 lambda) で getPkg1Cart → 来店予定フローを復帰させる。
 */
export async function setPkg1Cart(
  env: TrycleRepoEnv,
  lineUserId: string,
  cart: QuoteLineItem[],
): Promise<void> {
  await supabaseUpsert(
    env,
    'bot_sessions',
    [
      {
        tenant_id: getTenantId(env),
        line_user_id: lineUserId,
        kind: PKG1_CART_KIND,
        state: { cart },
        updated_at: new Date().toISOString(),
      },
    ],
    { onConflict: 'tenant_id,line_user_id,kind' },
  );
}

/** 退避した cart を取得する (同意書 callback の復帰用)。未存在なら null。 */
export async function getPkg1Cart(
  env: TrycleRepoEnv,
  lineUserId: string,
): Promise<QuoteLineItem[] | null> {
  const rows = await supabaseSelect<{ state: { cart?: QuoteLineItem[] } }>(
    env,
    'bot_sessions',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      line_user_id: `eq.${lineUserId}`,
      kind: `eq.${PKG1_CART_KIND}`,
    },
    { select: 'state', limit: 1 },
  );
  const cart = rows[0]?.state?.cart;
  return Array.isArray(cart) ? cart : null;
}

/** 退避した cart を削除する (callback 復帰後)。 */
export async function clearPkg1Cart(
  env: TrycleRepoEnv,
  lineUserId: string,
): Promise<void> {
  await supabaseDelete(env, 'bot_sessions', {
    tenant_id: `eq.${getTenantId(env)}`,
    line_user_id: `eq.${lineUserId}`,
    kind: `eq.${PKG1_CART_KIND}`,
  });
}

// ── reservation (来店予定フロー・経路 D-2) ────────────────────────────────────

export async function getReservationSession(
  env: TrycleRepoEnv,
  lineUserId: string,
): Promise<ReservationState | null> {
  const rows = await supabaseSelect<{ state: ReservationState }>(
    env,
    'bot_sessions',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      line_user_id: `eq.${lineUserId}`,
      kind: `eq.${RESERVATION_KIND}`,
    },
    { select: 'state', limit: 1 },
  );
  return rows[0]?.state ?? null;
}

export async function setReservationSession(
  env: TrycleRepoEnv,
  lineUserId: string,
  state: ReservationState,
): Promise<void> {
  await supabaseUpsert(
    env,
    'bot_sessions',
    [
      {
        tenant_id: getTenantId(env),
        line_user_id: lineUserId,
        kind: RESERVATION_KIND,
        state,
        updated_at: new Date().toISOString(),
      },
    ],
    { onConflict: 'tenant_id,line_user_id,kind' },
  );
}

export async function clearReservationSession(
  env: TrycleRepoEnv,
  lineUserId: string,
): Promise<void> {
  await supabaseDelete(env, 'bot_sessions', {
    tenant_id: `eq.${getTenantId(env)}`,
    line_user_id: `eq.${lineUserId}`,
    kind: `eq.${RESERVATION_KIND}`,
  });
}

/**
 * 来店予定確定を **原子的に claim** する (二重押下の冪等化・2026-06-23 真因)。
 *
 * LINE の確認 Flex「はい」を連続 2 回押す / webhook が retry すると、
 * `pkg1_reserve_confirm=ok` が 2 回届く。素朴な「read → 処理 → 末尾で delete」だと
 * 2 回目が delete 前の session を読み再度 finalize → case が 2 件作られる。
 *
 * DELETE … RETURNING representation で「自分が消した行」を受け取り、行があれば
 * この request が claim 成功 (=最初の 1 回)、空なら別 request が既に処理済み
 * (=2 回目以降) と判定できる。PostgREST の DELETE は単一行をアトミックに消すため、
 * 同時 2 リクエストでも「片方だけが行を受け取る」ことが保証される。
 *
 * @returns claim できた session state / 既に消費済みなら null。
 */
export async function claimReservationSession(
  env: TrycleRepoEnv,
  lineUserId: string,
): Promise<ReservationState | null> {
  const deleted = await supabaseDeleteReturning<{ state: ReservationState }>(
    env,
    'bot_sessions',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      line_user_id: `eq.${lineUserId}`,
      kind: `eq.${RESERVATION_KIND}`,
    },
  );
  return deleted[0]?.state ?? null;
}

/**
 * 来店予定 finalize 成功直後に「直近確定」マーカーを書く (連打の完全 silent 化)。
 *
 * claimReservationSession は「最初の 1 回」と「それ以外 (連打 2 回目 / session 失効)」
 * しか区別できない。後 2 者を分けるため、claim に成功した request だけがここで
 * confirmed_at を残す。2 回目の空 claim はこのマーカーの鮮度を見て
 * 「直近確定の重複 (= silent no-op)」か「本当の失効 (= graceful)」かを判定する。
 *
 * onConflict UPSERT なので 1 ユーザー : 1 行 (最新 confirmed_at で上書き)。
 */
export async function markReservationDone(
  env: TrycleRepoEnv,
  lineUserId: string,
  now: Date = new Date(),
): Promise<void> {
  await supabaseUpsert(
    env,
    'bot_sessions',
    [
      {
        tenant_id: getTenantId(env),
        line_user_id: lineUserId,
        kind: RESERVATION_DONE_KIND,
        state: { confirmed_at: now.toISOString() },
        updated_at: now.toISOString(),
      },
    ],
    { onConflict: 'tenant_id,line_user_id,kind' },
  );
}

/**
 * 来店予定が直近 (RECENT_CONFIRM_WINDOW_MS 以内) に確定済みかを判定する。
 * confirm の空 claim が「連打の 2 回目」なら true (→ silent)、それより古い /
 * マーカー無し なら false (→ session 失効として graceful 導線)。
 *
 * フェイルセーフ: 読み取り失敗時は false を返し graceful 導線へ倒す
 * (silent に倒して無反応に見せるより、再開導線を出すほうが安全)。
 */
export async function wasReservationRecentlyDone(
  env: TrycleRepoEnv,
  lineUserId: string,
  now: Date = new Date(),
): Promise<boolean> {
  let rows: { state: { confirmed_at?: string } }[];
  try {
    rows = await supabaseSelect<{ state: { confirmed_at?: string } }>(
      env,
      'bot_sessions',
      {
        tenant_id: `eq.${getTenantId(env)}`,
        line_user_id: `eq.${lineUserId}`,
        kind: `eq.${RESERVATION_DONE_KIND}`,
      },
      { select: 'state', limit: 1 },
    );
  } catch (err) {
    console.error('[trycle-session] wasReservationRecentlyDone lookup failed', err);
    return false;
  }
  const confirmedAt = rows[0]?.state?.confirmed_at;
  if (!confirmedAt) return false;
  const elapsed = now.getTime() - new Date(confirmedAt).getTime();
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= RECENT_CONFIRM_WINDOW_MS;
}

// ── 有人モード (REQ-PKG1-024) ────────────────────────────────────────────────

/**
 * スタッフ相談を選んだ user を有人モードにする (bot 自動応答を一時停止)。
 * リッチメニュー押下 (clearManualMode) で復帰する。
 */
export async function setManualMode(
  env: TrycleRepoEnv,
  lineUserId: string,
): Promise<void> {
  await supabaseUpsert(
    env,
    'bot_sessions',
    [
      {
        tenant_id: getTenantId(env),
        line_user_id: lineUserId,
        kind: MANUAL_MODE_KIND,
        state: { active: true },
        updated_at: new Date().toISOString(),
      },
    ],
    { onConflict: 'tenant_id,line_user_id,kind' },
  );
}

/**
 * 有人モードか判定する。webhook の text/postback 経路の冒頭で呼び、
 * active なら bot 自動応答 (auto_reply / Pkg8 / Pkg1) を抑止する。
 * Supabase 未設定・例外時は false を返す (フェイルオープン: bot 応答継続)。
 */
export async function isManualMode(
  env: SupabaseEnvLike & { TRYCLE_TENANT_ID?: string },
  lineUserId: string,
): Promise<boolean> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.TRYCLE_TENANT_ID) {
    return false;
  }
  try {
    const rows = await supabaseSelect<{ state: { active?: boolean } }>(
      env as TrycleRepoEnv,
      'bot_sessions',
      {
        tenant_id: `eq.${env.TRYCLE_TENANT_ID}`,
        line_user_id: `eq.${lineUserId}`,
        kind: `eq.${MANUAL_MODE_KIND}`,
      },
      { select: 'state', limit: 1 },
    );
    return rows[0]?.state?.active === true;
  } catch (err) {
    console.error('[trycle-session] isManualMode lookup failed', err);
    return false;
  }
}

/** 有人モードを解除する (リッチメニュー押下で bot 応答へ復帰)。 */
export async function clearManualMode(
  env: TrycleRepoEnv,
  lineUserId: string,
): Promise<void> {
  await supabaseDelete(env, 'bot_sessions', {
    tenant_id: `eq.${getTenantId(env)}`,
    line_user_id: `eq.${lineUserId}`,
    kind: `eq.${MANUAL_MODE_KIND}`,
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** 外部から来た state を最低限の形に正規化する (cart 欠落等を防ぐ)。 */
function normalizeState(state: Partial<Pkg1State> | null | undefined): Pkg1State {
  return {
    step: state?.step ?? 'awaiting_dispatch',
    cart: Array.isArray(state?.cart) ? state!.cart : [],
    pending: state?.pending,
  };
}

/** cart の小計 (税抜・min) を返す。 */
export function cartSubtotal(cart: ReadonlyArray<QuoteLineItem>): number {
  return cart.reduce((sum, item) => sum + item.amount, 0);
}
