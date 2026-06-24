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
 * 直近の (未削除) 案件を line_user_id で 1 件引く (assignee / store の引き継ぎ用)。
 * 案件が無い (まだ見積も予約もしていない) 相談もあるため null 許容。
 * スタッフ相談で **既存 case を相談中に降格させない** ため status の参照のみに使う
 * (新規 case 作成時の assignee / store ヒントとして・既存 case の status は不変)。
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
 * @deprecated 既存 case を相談中に「降格」させる旧実装。Phase 4 bugfix で削除予定。
 * 代わりに createStaffConsultCase を使う (= 新規 case を status='talking' で insert)。
 * このまま残すと既存 case (見積完了・予約済み等) を上書きしてしまうため使ってはいけない。
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

export interface CreateStaffConsultCaseInput {
  readonly lineUserId: string;
  readonly customerId: string | null;
  readonly inquiryText: string;
  /** 直近 case から引き継ぐ store/assignee。新規顧客なら null。 */
  readonly inheritedStoreId: string | null;
  readonly inheritedAssigneeId: string | null;
}

/**
 * スタッフ相談用に **新規 case を 1 件作成** する (既存 case は触らない)。
 * status は 'talking' (相談中)・work_note と chat_summary に経路情報を残す。
 *
 * - line_user_id は引数で必須
 * - customer_id は引数で渡す (未登録顧客なら NULL・後で経路 E 同様に attach 可)
 * - store_id / assignee_id は直近 case から引き継ぎ (新規顧客は NULL)
 * - status_id は case_statuses.key='talking'
 *
 * 失敗すると Throws (呼び出し側で catch すること)。
 */
export async function createStaffConsultCase(
  env: TrycleRepoEnv,
  input: CreateStaffConsultCaseInput,
): Promise<{ caseId: string }> {
  const tenantId = getTenantId(env);
  const statusId = await findTalkingStatusId(env);
  if (!statusId) {
    throw new Error('createStaffConsultCase: talking status not found in case_statuses');
  }
  const chatSummary = input.inquiryText.trim().length > 0
    ? `スタッフ相談: ${input.inquiryText.trim().slice(0, 200)}`
    : 'スタッフ相談 (内容未入力でゲート起動)';
  const rows = await supabaseUpsert<{ id: string }>(
    env,
    'cases',
    [
      {
        tenant_id: tenantId,
        customer_id: input.customerId,
        store_id: input.inheritedStoreId,
        status_id: statusId,
        assignee_id: input.inheritedAssigneeId,
        line_user_id: input.lineUserId,
        work_note: 'スタッフ相談 (B1 内容確認ループ)',
        chat_summary: chatSummary,
        updated_at: new Date().toISOString(),
      },
    ],
    { returning: 'representation' },
  );
  const caseId = rows?.[0]?.id;
  if (!caseId) throw new Error('createStaffConsultCase: cases insert returned no id');
  return { caseId };
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
