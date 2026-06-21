/**
 * TRYCLE Pkg1 session state (bot_sessions) + 有人モード (manual_mode) helpers.
 *
 * 設計: Pkg1 詳細設計 v1.1.1 §4 / §7 (page 386050ad6a7e81f8b701cd52c9201af6)。
 *
 * - `bot_sessions` (Supabase・migration 0016) は **bot ロジックの作業メモ** =
 *   region→symptom→variant→qty→cart の状態スナップショットを保持する。
 *   会話履歴ではない (履歴は LH 標準 messages_log = D1 が正本)。
 * - kind='pkg1_estimate' = 見積フローの作業状態。
 * - kind='manual_mode'   = 有人切替フラグ (REQ-PKG1-024)。LH §9 Inbox に
 *   標準の bot 抑止機構は無いため (catalog grep 確認済) bot_sessions で実装する。
 *
 * UNIQUE (tenant_id, line_user_id, kind) なので 1 ユーザー : 1 active session/kind。
 */
import {
  supabaseSelect,
  supabaseUpsert,
  supabaseDelete,
  type SupabaseEnvLike,
} from './supabase.js';
import { getTenantId, type TrycleRepoEnv } from './trycle-repo.js';

export const PKG1_SESSION_KIND = 'pkg1_estimate';
export const MANUAL_MODE_KIND = 'manual_mode';

/** 24 時間無操作で stale 扱い (設計 §7 session ライフサイクル)。 */
export const SESSION_STALE_MS = 24 * 60 * 60 * 1000;

export type Pkg1Step =
  | 'category_select'
  | 'labor_select'
  | 'cart_review'
  | 'quoted'
  | 'visit_time_select';

export interface CartItem {
  readonly labor_id: string;
  readonly code: string;
  readonly name: string;
  readonly unit_price: number;
  readonly unit_price_max: number | null;
  readonly qty: number;
  /** 選択された labor_options (variant) の合計加算と表示名。 */
  readonly option_ids: string[];
  readonly option_names: string[];
  readonly option_total: number;
}

export interface Pkg1State {
  readonly step: Pkg1Step;
  readonly cart: CartItem[];
  readonly selected_category?: string;
  readonly selected_labor_id?: string;
  /** 見積保存後に作成された case の id (経路 D の来店予定で参照)。 */
  readonly case_id?: string;
  readonly store_id?: string;
}

interface BotSessionRow {
  readonly state: Pkg1State;
  readonly updated_at: string;
}

/** 空の Pkg1 セッション初期値。 */
export function emptyPkg1State(): Pkg1State {
  return { step: 'category_select', cart: [] };
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
    step: state?.step ?? 'category_select',
    cart: Array.isArray(state?.cart) ? state!.cart : [],
    selected_category: state?.selected_category,
    selected_labor_id: state?.selected_labor_id,
    case_id: state?.case_id,
    store_id: state?.store_id,
  };
}

/** cart の小計 (税抜・min) を返す。 */
export function cartSubtotal(cart: ReadonlyArray<CartItem>): number {
  return cart.reduce(
    (sum, item) => sum + (item.unit_price + item.option_total) * item.qty,
    0,
  );
}
