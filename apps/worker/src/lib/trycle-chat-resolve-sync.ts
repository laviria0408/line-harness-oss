/**
 * TRYCLE chat → case 連動 (Task #33)。
 *
 * LH 管理画面のオペレーターチャットを「解決済 (status='resolved')」にしたとき、
 * 同じ LINE ユーザーの「相談中 (case_statuses.key='talking')」案件を
 * 「完了 (case_statuses.key='done')」へ自動遷移させる。
 *
 * 設計判断 (Approach: 直接 Supabase 書き込み)
 *   bot は TRYCLE cases の正本 Supabase を dashboard と共有しており、case 状態は
 *   既に `supabaseUpsert`/`supabaseUpdate` で直接書く設計 (trycle-pkg1-repo /
 *   trycle-reservation-gate の先例)。dashboard は case status を Supabase から
 *   読むため、ここで status_id を書けば dashboard に自動で反映される。新規 HTTP
 *   endpoint・追加 infra・新しい認証面を増やさない最小実装。
 *
 * best-effort 規約
 *   - chats テーブルの status 変更 (D1) は本同期の成否に関係なく成功させる。
 *   - 同期失敗は console に記録するが throw しない (呼び出し側を巻き戻さない)。
 *   - line_user_id は log に生値を残さない (マスクして記録)。
 */
import { supabaseSelect, supabaseUpdate, type SupabaseEnvLike } from './supabase.js';

/** dashboard 側 case_statuses.key (src/db/seed.ts と一致)。 */
const TALKING_STATUS_KEY = 'talking';
const DONE_STATUS_KEY = 'done';

export interface ChatResolveSyncEnv extends SupabaseEnvLike {
  TRYCLE_TENANT_ID?: string;
}

interface CaseStatusRow {
  readonly id: string;
  readonly key: string;
}

interface CaseRow {
  readonly id: string;
}

export interface ChatResolveSyncResult {
  /** 完了へ遷移できた case 件数 (0 = 対象なし or 設定未整備)。 */
  readonly updatedCount: number;
  /** スキップ理由 (success 時は undefined)。観測用。 */
  readonly skippedReason?:
    | 'tenant-unset'
    | 'supabase-unset'
    | 'invalid-line-user-id'
    | 'no-done-status'
    | 'no-talking-case'
    | 'error';
}

/** line_user_id を log 用にマスクする (先頭 5 文字のみ)。 */
export function maskLineUserId(lineUserId: string): string {
  if (lineUserId.length <= 5) return '***';
  return `${lineUserId.slice(0, 5)}***`;
}

/** LINE userId の体裁 (U + 32 hex)。緩めに U 始まり + 長さで判定。 */
export function isValidLineUserId(value: string): boolean {
  return /^U[0-9a-f]{32}$/i.test(value);
}

/**
 * chat の status 遷移が「解決済へ入った」ものか判定する。
 * - 解決済 = 'resolved'
 * - previousStatus が既に 'resolved' の場合は no-op (重複発火を避ける)
 */
export function shouldSyncCaseComplete(
  nextStatus: string | undefined,
  previousStatus: string | undefined,
): boolean {
  if (nextStatus !== 'resolved') return false;
  if (previousStatus === 'resolved') return false;
  return true;
}

function isReady(env: ChatResolveSyncEnv): true | ChatResolveSyncResult {
  if (!env.TRYCLE_TENANT_ID) {
    return { updatedCount: 0, skippedReason: 'tenant-unset' };
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return { updatedCount: 0, skippedReason: 'supabase-unset' };
  }
  return true;
}

/**
 * chat 解決済 → dashboard case を「完了」に連動する本体。
 *
 * 対象 = tenant スコープ・line_user_id 一致・現ステータスが 'talking' (相談中) の
 * 案件すべて。最新 1 件に絞らないのは、同一ユーザーに相談中案件が複数あれば
 * いずれも解決済と見なすのが自然 (運用上は通常 1 件)。
 */
export async function syncCaseCompleteOnChatResolved(
  env: ChatResolveSyncEnv,
  lineUserId: string,
): Promise<ChatResolveSyncResult> {
  const ready = isReady(env);
  if (ready !== true) return ready;

  if (!isValidLineUserId(lineUserId)) {
    return { updatedCount: 0, skippedReason: 'invalid-line-user-id' };
  }

  const tenantId = env.TRYCLE_TENANT_ID as string;

  try {
    // 1) talking / done の status_id を解決 (tenant スコープ)。
    const statuses = await supabaseSelect<CaseStatusRow>(
      env,
      'case_statuses',
      {
        tenant_id: `eq.${tenantId}`,
        key: `in.(${TALKING_STATUS_KEY},${DONE_STATUS_KEY})`,
      },
      { select: 'id,key', limit: 2 },
    );
    const talkingId = statuses.find((s) => s.key === TALKING_STATUS_KEY)?.id ?? null;
    const doneId = statuses.find((s) => s.key === DONE_STATUS_KEY)?.id ?? null;
    if (!doneId) {
      // 完了ステータス未整備の tenant では何もしない (誤書き込み回避)。
      return { updatedCount: 0, skippedReason: 'no-done-status' };
    }

    // 2) 相談中の対象 case を特定。talking status が無ければ対象なし。
    if (!talkingId) {
      return { updatedCount: 0, skippedReason: 'no-talking-case' };
    }
    const cases = await supabaseSelect<CaseRow>(
      env,
      'cases',
      {
        tenant_id: `eq.${tenantId}`,
        line_user_id: `eq.${lineUserId}`,
        status_id: `eq.${talkingId}`,
        deleted_at: 'is.null',
      },
      { select: 'id', order: 'created_at.desc', limit: 50 },
    );
    if (cases.length === 0) {
      return { updatedCount: 0, skippedReason: 'no-talking-case' };
    }

    // 3) 相談中 → 完了 へ status_id を更新 (status_id 一致を WHERE に残し、
    //    同期中に他経路で status が変わった行を上書きしない = 競合に安全)。
    await supabaseUpdate(
      env,
      'cases',
      {
        tenant_id: `eq.${tenantId}`,
        line_user_id: `eq.${lineUserId}`,
        status_id: `eq.${talkingId}`,
        deleted_at: 'is.null',
      },
      {
        status_id: doneId,
        updated_at: new Date().toISOString(),
      },
    );

    return { updatedCount: cases.length };
  } catch (err) {
    console.error(
      `[trycle-chat-resolve-sync] case 完了連動に失敗 (user=${maskLineUserId(lineUserId)}):`,
      err,
    );
    return { updatedCount: 0, skippedReason: 'error' };
  }
}
