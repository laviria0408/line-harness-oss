/**
 * スタッフ相談の通知ルーティング解決 (Phase 4・案件相談中の二重発火の頭脳)。
 *
 * dashboard 側 `src/lib/notify-rules.ts` の `notifyRules.caseStaffConsult` が
 * source of truth (型・key 名・既定値を完全一致させる)。bot はそれを読み、
 * 案件の担当有無に応じて 3 状態 (assigned / unassigned / owner) のルールを選び、
 * 通知先 (manager / assignee / owner / all_owners / all / {user_id}) を Supabase
 * users から解決して「誰に・どの経路 (dashboard / email) で」のリストを返す。
 *
 * - 解決だけを行う純粋な repo/ロジック層 (通知の実発火 = trycle-staff.ts)。
 * - web_push は Phase 4 では skip (型は受けるが via に乗っても無視する)。
 * - tenants.settings.notifyRules 未設定なら既定ルール (dashboard と同じ) を使う。
 *
 * 設計: Pkg8 詳細設計 v2.4 (385050ad6a7e8168b815c6c897f607f9) + dashboard Phase 3。
 */
import { supabaseSelect } from './supabase.js';
import { getTenantId, type TrycleRepoEnv } from './trycle-repo.js';

// ── 型 (dashboard src/lib/notify-rules.ts と一致させる) ────────────────────────

/** 通知先の論理ターゲット。個別 user 指定は { user_id }。 */
export type NotifyRuleTarget =
  | 'manager'
  | 'assignee'
  | 'owner'
  | 'all_owners'
  | 'all'
  | 'superadmin'
  | { user_id: string };

/** 通知経路。web_push は Phase 4 では未実装 (受けるが skip)。 */
export type NotifyRuleChannel = 'dashboard' | 'email' | 'web_push';

export interface NotifyRule {
  readonly to: NotifyRuleTarget;
  readonly via: ReadonlyArray<NotifyRuleChannel>;
}

export interface CaseStaffConsultRules {
  /** superadmin 向け (UI 非表示・default: all へ dashboard・user 仕様 2026-06-24)。 */
  readonly superadmin?: NotifyRule;
  readonly unassigned: NotifyRule;
  readonly assigned: NotifyRule;
  readonly owner: NotifyRule;
}

/** dashboard DEFAULT_CASE_STAFF_CONSULT_RULES と完全一致 (fallback の正本)。 */
export const DEFAULT_CASE_STAFF_CONSULT_RULES: CaseStaffConsultRules = {
  superadmin: { to: 'superadmin', via: ['dashboard'] },
  unassigned: { to: 'manager', via: ['dashboard', 'email'] },
  assigned: { to: 'assignee', via: ['dashboard', 'email'] },
  owner: { to: 'all_owners', via: ['dashboard'] },
};

const VALID_TARGETS: ReadonlySet<string> = new Set([
  'manager',
  'assignee',
  'owner',
  'all_owners',
  'all',
  'superadmin',
]);
const VALID_CHANNELS: ReadonlyArray<NotifyRuleChannel> = ['dashboard', 'email', 'web_push'];

// ── 通知先 user の解決結果 ─────────────────────────────────────────────────────

/** 解決済みの 1 宛先 (dashboard 行 1 件 + email 1 通の素材)。 */
export interface ResolvedRecipient {
  /** 通知対象 user。'all' (全体通知) のときは null (notifications.target_user_id=NULL)。 */
  readonly userId: string | null;
  /** email 送信先 (users.email)。未設定 / null なら email は送れない。 */
  readonly email: string | null;
  /** 表示名 (ログ / dashboard 表示補助)。 */
  readonly displayName: string | null;
}

/** ルール解決の最終結果。dashboard 行を書くか・email を送るか・誰宛か。 */
export interface NotifyResolution {
  /** 適用したルールの状態 (assigned / unassigned)。owner は別途加算。 */
  readonly state: 'assigned' | 'unassigned';
  /** dashboard 通知 (notifications row) を出すべき宛先。 */
  readonly dashboardRecipients: ReadonlyArray<ResolvedRecipient>;
  /** email を送るべき宛先 (email が解決できたものだけ)。 */
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

function sanitizeTarget(raw: unknown, fallback: NotifyRuleTarget): NotifyRuleTarget {
  if (typeof raw === 'string' && VALID_TARGETS.has(raw)) {
    return raw as NotifyRuleTarget;
  }
  if (raw && typeof raw === 'object' && 'user_id' in raw) {
    const id = (raw as { user_id: unknown }).user_id;
    if (typeof id === 'string' && id.length > 0) return { user_id: id };
  }
  return fallback;
}

function sanitizeChannels(
  raw: unknown,
  fallback: ReadonlyArray<NotifyRuleChannel>,
): NotifyRuleChannel[] {
  if (!Array.isArray(raw)) return [...fallback];
  const out = VALID_CHANNELS.filter((c) => raw.includes(c));
  return out.length > 0 ? out : [...fallback];
}

function sanitizeRule(raw: unknown, fallback: NotifyRule): NotifyRule {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    to: sanitizeTarget(r.to, fallback.to),
    via: sanitizeChannels(r.via, fallback.via),
  };
}

/** caseStaffConsult を default にマージ (dashboard mergeCaseStaffConsult と同形)。 */
export function mergeCaseStaffConsult(raw: unknown): CaseStaffConsultRules {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    superadmin: sanitizeRule(r.superadmin, DEFAULT_CASE_STAFF_CONSULT_RULES.superadmin ?? { to: 'all', via: ['dashboard'] }),
    unassigned: sanitizeRule(r.unassigned, DEFAULT_CASE_STAFF_CONSULT_RULES.unassigned),
    assigned: sanitizeRule(r.assigned, DEFAULT_CASE_STAFF_CONSULT_RULES.assigned),
    owner: sanitizeRule(r.owner, DEFAULT_CASE_STAFF_CONSULT_RULES.owner),
  };
}

/**
 * tenants.settings.notifyRules.caseStaffConsult を取得する。
 * 未設定 / 取得失敗時は既定ルール (dashboard と同じ) を返す (フェイルセーフ)。
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

/** 案件のスナップショット (担当 / 店舗)。通知先解決の入力。 */
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

async function findUserById(env: TrycleRepoEnv, userId: string): Promise<UserRow | null> {
  const rows = await supabaseSelect<UserRow>(
    env,
    'users',
    { tenant_id: `eq.${getTenantId(env)}`, id: `eq.${userId}` },
    { select: 'id,email,display_name,role,store_id', limit: 1 },
  );
  return rows[0] ?? null;
}

/**
 * NotifyRuleTarget を具体的な宛先 user リストに解決する。
 *
 * - assignee  → cases.assignee_id (無ければ空)
 * - manager   → role='manager' (案件 store に絞る・無ければ tenant 全 manager)
 * - owner     → role='owner' の先頭 1 名
 * - all_owners→ role='owner' 全員
 * - all       → target_user_id=NULL の全体通知 1 件 ({ userId:null })
 * - {user_id} → その user 1 名
 *
 * 例外時は空配列 (通知できる宛先が無いだけで user フローは止めない)。
 */
export async function resolveTarget(
  env: TrycleRepoEnv,
  target: NotifyRuleTarget,
  caseRef: NotifyCaseRef,
): Promise<ResolvedRecipient[]> {
  try {
    if (typeof target === 'object') {
      const u = await findUserById(env, target.user_id);
      return u ? [toRecipient(u)] : [];
    }
    if (target === 'all') {
      return [{ userId: null, email: null, displayName: null }];
    }
    if (target === 'superadmin') {
      const supers = await findUsersByRole(env, 'superadmin');
      return supers.map(toRecipient);
    }
    if (target === 'assignee') {
      if (!caseRef.assigneeId) return [];
      const u = await findUserById(env, caseRef.assigneeId);
      return u ? [toRecipient(u)] : [];
    }
    if (target === 'manager') {
      // store 担当の店長を優先。store 紐付け manager が居なければ tenant 全 manager。
      const scoped = await findUsersByRole(env, 'manager', caseRef.storeId);
      const managers = scoped.length > 0 ? scoped : await findUsersByRole(env, 'manager');
      return managers.map(toRecipient);
    }
    if (target === 'owner') {
      const owners = await findUsersByRole(env, 'owner');
      return owners.length > 0 ? [toRecipient(owners[0]!)] : [];
    }
    if (target === 'all_owners') {
      const owners = await findUsersByRole(env, 'owner');
      return owners.map(toRecipient);
    }
    return [];
  } catch (err) {
    console.error('[trycle-notify-rules] resolveTarget failed', { target }, err);
    return [];
  }
}

/** userId で重複排除 (同一 user が複数ルールに該当しても 1 件にまとめる)。 */
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
 * 案件相談の通知先を解決する (assigned/unassigned ルール + owner 集約ルール)。
 *
 * 1) 担当の有無で assigned / unassigned のどちらのルールを使うか決める
 * 2) そのルール + owner ルールの両方の通知先を解決して合算
 * 3) via ごとに dashboard / email の宛先リストを作る (web_push は無視)
 *    - dashboard: userId 単位で dedupe
 *    - email:     email が解決できた宛先のみ・email 単位で dedupe
 */
export async function resolveCaseStaffConsult(
  env: TrycleRepoEnv,
  caseRef: NotifyCaseRef,
): Promise<NotifyResolution> {
  const rules = await getCaseStaffConsultRules(env);
  const state: 'assigned' | 'unassigned' = caseRef.assigneeId ? 'assigned' : 'unassigned';
  const primaryRule = rules[state];
  const ownerRule = rules.owner;
  // superadmin は user 仕様で「基本全部」(UI 非表示・user 自身が受け取る前提)。
  // rule が無ければ default を使う (mergeCaseStaffConsult 経由で補完済のはず)。
  const superadminRule = rules.superadmin ?? DEFAULT_CASE_STAFF_CONSULT_RULES.superadmin!;

  const dashboard: ResolvedRecipient[] = [];
  const emails: ResolvedRecipient[] = [];

  for (const rule of [primaryRule, ownerRule, superadminRule]) {
    const recipients = await resolveTarget(env, rule.to, caseRef);
    if (rule.via.includes('dashboard')) dashboard.push(...recipients);
    if (rule.via.includes('email')) {
      emails.push(...recipients.filter((r) => r.email && r.email.length > 0));
    }
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
