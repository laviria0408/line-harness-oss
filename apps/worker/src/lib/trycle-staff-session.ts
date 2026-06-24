/**
 * スタッフ相談「内容確認ループ」の session 状態 (Pkg8 faq_staff / Pkg1 escalate 共通)。
 *
 * 顧客が相談内容を自由文入力 → 確認 → [はい]/[追記する] のループを保持する (B1 仕様)。
 * Pkg1 既存の bot_sessions (kind=pkg1_estimate 等) と衝突しないよう独立 kind
 * (`staff_consult`) を使う。session 層 (trycle-session.ts) は Pkg1/予約フローが
 * 並行編集するため、本ループ専用の薄い state はここに分離する (低結合)。
 *
 * 設計: Pkg8 詳細設計 v2.4 (385050ad6a7e8168b815c6c897f607f9) B1。
 */
import { supabaseSelect, supabaseUpsert, supabaseDelete } from './supabase.js';
import { getTenantId, type TrycleRepoEnv } from './trycle-repo.js';

/** スタッフ相談 内容確認ループの bot_sessions kind。 */
export const STAFF_CONSULT_KIND = 'staff_consult';

/** 追記上限 (Pkg8 spec: 2 回まで)。到達で自動送信する。 */
export const STAFF_CONSULT_MAX_APPEND = 2;

/** 「はい」連打を重複と見なす窓 (この窓内の 2 回目以降は silent)。 */
export const STAFF_CONSULT_CONFIRM_DEBOUNCE_MS = 3 * 1000;

/** 24h 無操作で stale (Pkg1 session と同じライフサイクル)。 */
const STAFF_CONSULT_STALE_MS = 24 * 60 * 60 * 1000;

/** 相談の起点 (通知文言・status 遷移の文脈に使う)。 */
export type StaffConsultSource = 'pkg1' | 'pkg8';

/**
 * 内容確認ループの状態。
 * - content      : これまでに顧客が入力した相談内容 (追記で連結)
 * - appendCount  : 「追記する」を押した回数 (STAFF_CONSULT_MAX_APPEND が上限)
 * - awaiting     : 'input' = 自由文入力待ち / 'confirm' = はい/追記の選択待ち
 * - source       : pkg1 / pkg8 (通知の起点)
 * - reason       : 通知に載せる「きっかけ」(例: お悩み相談 / FAQ スタッフ相談)
 * - lastConfirmAt: 「はい」連打 debounce 用の最終確定 ISO timestamp
 */
export interface StaffConsultState {
  readonly content: string;
  readonly appendCount: number;
  readonly awaiting: 'input' | 'confirm';
  readonly source: StaffConsultSource;
  readonly reason: string;
  readonly lastConfirmAt?: string;
}

interface ConsultRow {
  readonly state: StaffConsultState;
  readonly updated_at: string;
}

function normalize(state: Partial<StaffConsultState> | null | undefined): StaffConsultState {
  return {
    content: typeof state?.content === 'string' ? state.content : '',
    appendCount: typeof state?.appendCount === 'number' ? state.appendCount : 0,
    awaiting: state?.awaiting === 'confirm' ? 'confirm' : 'input',
    source: state?.source === 'pkg1' ? 'pkg1' : 'pkg8',
    reason: typeof state?.reason === 'string' ? state.reason : 'スタッフ相談',
    lastConfirmAt: typeof state?.lastConfirmAt === 'string' ? state.lastConfirmAt : undefined,
  };
}

/** 内容確認ループ session を取得する。stale / 未存在なら null。 */
export async function getStaffConsult(
  env: TrycleRepoEnv,
  lineUserId: string,
  now: Date = new Date(),
): Promise<StaffConsultState | null> {
  const rows = await supabaseSelect<ConsultRow>(
    env,
    'bot_sessions',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      line_user_id: `eq.${lineUserId}`,
      kind: `eq.${STAFF_CONSULT_KIND}`,
    },
    { select: 'state,updated_at', limit: 1 },
  );
  const row = rows[0];
  if (!row) return null;
  if (now.getTime() - new Date(row.updated_at).getTime() > STAFF_CONSULT_STALE_MS) {
    return null;
  }
  return normalize(row.state);
}

/** 内容確認ループ session を UPSERT する (state を丸ごと上書き)。 */
export async function setStaffConsult(
  env: TrycleRepoEnv,
  lineUserId: string,
  state: StaffConsultState,
): Promise<void> {
  await supabaseUpsert(
    env,
    'bot_sessions',
    [
      {
        tenant_id: getTenantId(env),
        line_user_id: lineUserId,
        kind: STAFF_CONSULT_KIND,
        state,
        updated_at: new Date().toISOString(),
      },
    ],
    { onConflict: 'tenant_id,line_user_id,kind' },
  );
}

/** 内容確認ループ session を削除する (送信完了 / リセット時)。 */
export async function clearStaffConsult(env: TrycleRepoEnv, lineUserId: string): Promise<void> {
  await supabaseDelete(env, 'bot_sessions', {
    tenant_id: `eq.${getTenantId(env)}`,
    line_user_id: `eq.${lineUserId}`,
    kind: `eq.${STAFF_CONSULT_KIND}`,
  });
}
