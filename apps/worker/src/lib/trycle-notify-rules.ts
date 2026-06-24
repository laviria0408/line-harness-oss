/**
 * スタッフ相談の通知ルーティング解決 (案件相談中の二重発火の頭脳)。
 *
 * dashboard 側 `src/lib/notify-rules.ts` の `notifyRules.caseStaffConsult` が
 * source of truth (型・key 名・既定値を完全一致させる)。bot はそれを読み、
 * 案件の担当有無に応じて unassigned / assigned のルールを選び、toRoles 配列
 * (owner / manager / staff の組合せ) の通知先を Supabase users から解決して
 * 「誰に・どの経路 (dashboard / email) で」のリストを返す。
 *
 * user 仕様 2026-06-25 確定 (表形式):
 *                  owner   manager   staff
 *   未割当の相談    ☑       ☑         ⬜
 *   割当済の相談    ☑       ☑         ☑
 *
 * superadmin (本部 user) は UI 非表示・bot resolver で常時通知発火。
 * web_push は Phase 4 では skip (型は受けるが via に乗っても無視する)。
 */
import { supabaseSelect } from './supabase.js';
import { getTenantId, type TrycleRepoEnv } from './trycle-repo.js';

// ── 型 (dashboard src/lib/notify-rules.ts と一致) ─────────────────────────────

/** 通知対象 role (case 状態 row で複数選択可能)。 */
export type NotifyRoleTarget = 'owner' | 'manager' | 'staff';

/** 通知経路。web_push は Phase 4 では未実装。 */
export type NotifyRuleChannel = 'dashboard' | 'email' | 'web_push';

export interface NotifyRule {
  readonly toRoles: ReadonlyArray<NotifyRoleTarget>;
  readonly via: ReadonlyArray<NotifyRuleChannel>;
}

export interface CaseStaffConsultRules {
  readonly unassigned: NotifyRule;
  readonly assigned: NotifyRule;
}

/** dashboard DEFAULT_CASE_STAFF_CONSULT_RULES と完全一致 (fallback の正本)。
 *  user 表通り: 未割当=owner+manager / 割当済=owner+manager+staff。 */
export const DEFAULT_CASE_STAFF_CONSULT_RULES: CaseStaffConsultRules = {
  unassigned: { toRoles: ['owner', 'manager'], via: ['dashboard', 'email'] },
  assigned: { toRoles: ['owner', 'manager', 'staff'], via: ['dashboard', 'email'] },
};

const VALID_ROLES: ReadonlyArray<NotifyRoleTarget> = ['owner', 'manager', 'staff'];
const VALID_CHANNELS: ReadonlyArray<NotifyRuleChannel> = ['dashboard', 'email', 'web_push'];

// ── 通知先 user の解決結果 ─────────────────────────────────────────────────────

export interface ResolvedRecipient {
  readonly userId: string | null;
  readonly email: string | null;
  readonly displayName: string | null;
}

export interface NotifyResolution {
  readonly state: 'assigned' | 'unassigned';
  readonly dashboardRecipients: ReadonlyArray<ResolvedRecipient>;
  readonly emailRecipients: ReadonlyArray<ResolvedRecipient>;
}

// ── settings 読み取り + sanitize ───────────────────────────────────────────────

interface UserRow {
  readonly id: string;
  readonly email: string | null;
  readonly display_name: string | null;
  readonly role: string;
  readonly store_id: string | null;
}

interface TenantNotifySettingsRow {
  readonly settings: {
    notifyRules?: { caseStaffConsult?: unknown };
  } | null;
}

function sanitizeRoles(
  raw: unknown,
  fallback: ReadonlyArray<NotifyRoleTarget>,
): NotifyRoleTarget[] {
  if (!Array.isArray(raw)) return [...fallback];
  const out = VALID_ROLES.filter((r) => (raw as unknown[]).includes(r));
  return out.length > 0 ? out : [...fallback];
}

function sanitizeChannels(
  raw: unknown,
  fallback: ReadonlyArray<NotifyRuleChannel>,
): NotifyRuleChannel[] {
  if (!Array.isArray(raw)) return [...fallback];
  const out = VALID_CHANNELS.filter((c) => (raw as unknown[]).includes(c));
  return out.length > 0 ? out : [...fallback];
}

function sanitizeRule(raw: unknown, fallback: NotifyRule): NotifyRule {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    toRoles: sanitizeRoles(r.toRoles, fallback.toRoles),
    via: sanitizeChannels(r.via, fallback.via),
  };
}

/** caseStaffConsult を default にマージ (dashboard mergeCaseStaffConsult と同形)。 */
export function mergeCaseStaffConsult(raw: unknown): CaseStaffConsultRules {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    unassigned: sanitizeRule(r.unassigned, DEFAULT_CASE_STAFF_CONSULT_RULES.unassigned),
    assigned: sanitizeRule(r.assigned, DEFAULT_CASE_STAFF_CONSULT_RULES.assigned),
  };
}

/**
 * tenants.settings.notifyRules.caseStaffConsult を取得する。
 * 未設定 / 取得失敗時は既定ルールを返す (フェイルセーフ)。
 */
export async function getCaseStaffConsultRules(
  env: TrycleRepoEnv,
): Promise<CaseStaffConsultRules> {
  try {
    const rows = await supabaseSelect<TenantNotifySettingsRow>(
      env,
      'tenants',
      { id: `eq.${getTenantId(env)}` },
      { select: 'settings', limit: 1 },
    );
    const raw = rows[0]?.settings?.notifyRules?.caseStaffConsult;
    if (raw === undefined || raw === null) return DEFAULT_CASE_STAFF_CONSULT_RULES;
    return mergeCaseStaffConsult(raw);
  } catch (err) {
    console.error('[trycle-notify-rules] getCaseStaffConsultRules failed, using default', err);
    return DEFAULT_CASE_STAFF_CONSULT_RULES;
  }
}

// ── target → user 解決 ─────────────────────────────────────────────────────────

export interface NotifyCaseRef {
  readonly assigneeId: string | null;
  readonly storeId: string | null;
}

function toRecipient(u: UserRow): ResolvedRecipient {
  return { userId: u.id, email: u.email, displayName: u.display_name };
}

/** role でユーザーを引く (任意で store_id 一致に絞る)。 */
async function findUsersByRole(
  env: TrycleRepoEnv,
  role: string,
  storeId?: string | null,
): Promise<UserRow[]> {
  const filter: Record<string, string> = {
    tenant_id: `eq.${getTenantId(env)}`,
    role: `eq.${role}`,
  };
  if (storeId) filter.store_id = `eq.${storeId}`;
  return supabaseSelect<UserRow>(env, 'users', filter, {
    select: 'id,email,display_name,role,store_id',
    limit: 50,
  });
}

/**
 * NotifyRoleTarget を具体的な宛先 user リストに解決する。
 *
 * - owner   → role='owner' 全員
 * - manager → role='manager' (案件 store に絞る・無ければ tenant 全 manager)
 * - staff   → role='staff' 全員 (= 担当者を含む)
 *
 * 例外時は空配列 (通知できる宛先が無いだけで user フローは止めない)。
 */
async function resolveRoleTarget(
  env: TrycleRepoEnv,
  role: NotifyRoleTarget,
  caseRef: NotifyCaseRef,
): Promise<ResolvedRecipient[]> {
  try {
    if (role === 'owner') {
      const owners = await findUsersByRole(env, 'owner');
      return owners.map(toRecipient);
    }
    if (role === 'manager') {
      const scoped = await findUsersByRole(env, 'manager', caseRef.storeId);
      const managers = scoped.length > 0 ? scoped : await findUsersByRole(env, 'manager');
      return managers.map(toRecipient);
    }
    if (role === 'staff') {
      const staff = await findUsersByRole(env, 'staff');
      return staff.map(toRecipient);
    }
    return [];
  } catch (err) {
    console.error('[trycle-notify-rules] resolveRoleTarget failed', { role }, err);
    return [];
  }
}

/** userId で重複排除 (同一 user が複数 role に該当しても 1 件にまとめる)。 */
function dedupeByUser(recipients: ReadonlyArray<ResolvedRecipient>): ResolvedRecipient[] {
  const seen = new Set<string>();
  const out: ResolvedRecipient[] = [];
  for (const r of recipients) {
    const key = r.userId ?? '__all__';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * 案件相談の通知先を解決する (新仕様 user 2026-06-25 表形式)。
 *
 * 1) 担当有無で assigned / unassigned のルールを選ぶ
 * 2) ルールの toRoles 各 role に該当する users を集約
 * 3) superadmin role users (本部) を常時加算 (UI 非表示・default dashboard 通知)
 * 4) via ごとに dashboard / email の宛先リストを作る
 *    - dashboard: userId 単位で dedupe
 *    - email:     email が解決できた宛先のみ・email 単位で dedupe
 */
export async function resolveCaseStaffConsult(
  env: TrycleRepoEnv,
  caseRef: NotifyCaseRef,
): Promise<NotifyResolution> {
  const rules = await getCaseStaffConsultRules(env);
  const state: 'assigned' | 'unassigned' = caseRef.assigneeId ? 'assigned' : 'unassigned';
  const rule = rules[state];

  const dashboard: ResolvedRecipient[] = [];
  const emails: ResolvedRecipient[] = [];

  // 1) ルールの toRoles を resolve
  for (const role of rule.toRoles) {
    const recipients = await resolveRoleTarget(env, role, caseRef);
    if (rule.via.includes('dashboard')) dashboard.push(...recipients);
    if (rule.via.includes('email')) {
      emails.push(...recipients.filter((r) => r.email && r.email.length > 0));
    }
  }

  // 2) superadmin (本部) を常時加算 (UI 非表示・default は dashboard 通知)
  try {
    const supers = await findUsersByRole(env, 'superadmin');
    const superRecipients = supers.map(toRecipient);
    dashboard.push(...superRecipients);
    // superadmin は dashboard のみ default。email を含めるかは将来の拡張で settings 化する。
  } catch (err) {
    console.error('[trycle-notify-rules] superadmin resolve failed', err);
  }

  // email は email アドレス単位で dedupe (user 別でなく宛先別)。
  const seenEmail = new Set<string>();
  const emailRecipients = emails.filter((r) => {
    if (!r.email) return false;
    if (seenEmail.has(r.email)) return false;
    seenEmail.add(r.email);
    return true;
  });

  return {
    state,
    dashboardRecipients: dedupeByUser(dashboard),
    emailRecipients,
  };
}
