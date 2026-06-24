/**
 * スタッフ相談通知の Supabase 書き込み層 (Phase 4)。
 *
 * - 案件相談時に直近案件を相談中 (case_statuses.key='talking') に遷移させる
 * - dashboard 通知 (notifications row) を 1 件作る (dashboard 側 schema と一致)
 * - 通知先の解決は trycle-notify-rules.ts (本ファイルは書き込みのみ)
 *
 * notifications テーブル列 (dashboard src/db/schema.ts と一致):
 *   tenant_id / type / category / title / detail / icon_key / icon_color /
 *   target_user_id (NULL=全体) / target_store_id / related_case_id / is_read
 *
 * 設計: Pkg8 詳細設計 v2.4 (385050ad6a7e8168b815c6c897f607f9) + dashboard Phase 3。
 */
import { supabaseSelect, supabaseUpdate, supabaseUpsert } from './supabase.js';
import { getTenantId, type TrycleRepoEnv } from './trycle-repo.js';

/** dashboard 通知の type / category (dashboard の使用値に揃える)。 */
export const STAFF_CONSULT_NOTIFICATION_TYPE = 'case-consult';
export const STAFF_CONSULT_NOTIFICATION_CATEGORY = 'case';
const STAFF_CONSULT_ICON_KEY = 'message-circle';
const STAFF_CONSULT_ICON_COLOR = '#a855f7';

export interface CaseRef {
  readonly caseId: string;
  readonly assigneeId: string | null;
  readonly storeId: string | null;
}

/**
 * 直近の (未削除) 案件を line_user_id で 1 件引く (相談中遷移・related_case_id 用)。
 * 案件が無い (まだ見積も予約もしていない) 相談もあるため null 許容。
 */
export async function findLatestCaseByLineUserId(
  env: TrycleRepoEnv,
  lineUserId: string,
): Promise<CaseRef | null> {
  const rows = await supabaseSelect<{
    id: string;
    assignee_id: string | null;
    store_id: string | null;
  }>(
    env,
    'cases',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      line_user_id: `eq.${lineUserId}`,
      deleted_at: 'is.null',
    },
    { select: 'id,assignee_id,store_id', order: 'created_at.desc', limit: 1 },
  );
  const row = rows[0];
  if (!row) return null;
  return { caseId: row.id, assigneeId: row.assignee_id, storeId: row.store_id };
}

/** case_statuses.key='talking' (相談中) の status_id を引く。無ければ null。 */
export async function findTalkingStatusId(env: TrycleRepoEnv): Promise<string | null> {
  const rows = await supabaseSelect<{ id: string }>(
    env,
    'case_statuses',
    { tenant_id: `eq.${getTenantId(env)}`, key: `eq.talking` },
    { select: 'id', limit: 1 },
  );
  return rows[0]?.id ?? null;
}

/**
 * 案件を相談中 (talking) に遷移させる。talking status が未定義 / case 無しなら no-op。
 * 失敗してもユーザーフローは止めない (呼び出し側 catch)。
 */
export async function markCaseTalking(env: TrycleRepoEnv, caseId: string): Promise<boolean> {
  const statusId = await findTalkingStatusId(env);
  if (!statusId) {
    console.error('[trycle-staff-repo] markCaseTalking skipped: no talking status');
    return false;
  }
  await supabaseUpdate(
    env,
    'cases',
    { id: `eq.${caseId}`, tenant_id: `eq.${getTenantId(env)}` },
    { status_id: statusId, updated_at: new Date().toISOString() },
  );
  return true;
}

export interface NotificationInput {
  readonly title: string;
  readonly detail: string;
  /** NULL = 全体通知 (dashboard で全 user に見える)。 */
  readonly targetUserId: string | null;
  readonly targetStoreId: string | null;
  readonly relatedCaseId: string | null;
}

/**
 * dashboard 通知 (notifications row) を 1 件作る。dashboard 側 schema の列に揃える。
 * 機密 (line_user_id 生値 / token) は title / detail に載せない (呼び出し側で除外)。
 */
export async function insertNotification(
  env: TrycleRepoEnv,
  input: NotificationInput,
): Promise<void> {
  await supabaseUpsert(
    env,
    'notifications',
    [
      {
        tenant_id: getTenantId(env),
        type: STAFF_CONSULT_NOTIFICATION_TYPE,
        category: STAFF_CONSULT_NOTIFICATION_CATEGORY,
        title: input.title,
        detail: input.detail,
        icon_key: STAFF_CONSULT_ICON_KEY,
        icon_color: STAFF_CONSULT_ICON_COLOR,
        target_user_id: input.targetUserId,
        target_store_id: input.targetStoreId,
        related_case_id: input.relatedCaseId,
        is_read: false,
        created_at: new Date().toISOString(),
      },
    ],
  );
}
