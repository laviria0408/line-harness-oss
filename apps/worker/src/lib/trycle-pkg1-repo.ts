/**
 * TRYCLE Pkg1 (整備見積) 専用 Supabase アクセス層。
 *
 * 既存の trycle-repo.ts (customers/consents/stores/labor_master 単件) を壊さず、
 * Pkg1 のカテゴリ→作業→variant→cart→案件作成に必要な複数件取得 / 案件 INSERT を
 * ここに追加する。canonical は Tenant Supabase 直読み (Pkg8 と同方針)。
 *
 * 設計: Pkg1 詳細設計 v1.1.1 §4 / §5 (page 386050ad6a7e81f8b701cd52c9201af6)。
 */
import { supabaseSelect, supabaseUpsert } from './supabase.js';
import {
  getTenantId,
  type TrycleRepoEnv,
  type LaborEntry,
  type LaborOption,
} from './trycle-repo.js';

/**
 * labor_master.price_max (上限・range 見積用) は既存 LaborEntry に無いので
 * Pkg1 用に拡張する。null = 上限なし (単価固定 or open-ended)。
 */
export interface Pkg1LaborEntry extends LaborEntry {
  readonly price_max: number | null;
}

// ── Labor master: カテゴリ / カテゴリ内一覧 / id 取得 ──────────────────────────

/**
 * tenant の有効な工賃カテゴリを sort_order 昇順で distinct 取得する。
 * (REQ-PKG1-004 カテゴリ選択 Bubble の元データ)
 */
export async function listLaborCategories(
  env: TrycleRepoEnv,
): Promise<string[]> {
  const rows = await supabaseSelect<{ category: string; sort_order: number }>(
    env,
    'labor_master',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      archived: 'eq.false',
    },
    { select: 'category,sort_order', order: 'sort_order.asc', limit: 1000 },
  );
  const seen = new Set<string>();
  const categories: string[] = [];
  for (const row of rows) {
    if (!seen.has(row.category)) {
      seen.add(row.category);
      categories.push(row.category);
    }
  }
  return categories;
}

/**
 * 指定カテゴリの工賃を sort_order 昇順で取得する。
 * (REQ-PKG1-005 メニュー (variant) 選択 Bubble の元データ)
 */
export async function listLaborByCategory(
  env: TrycleRepoEnv,
  category: string,
): Promise<Pkg1LaborEntry[]> {
  return supabaseSelect<Pkg1LaborEntry>(
    env,
    'labor_master',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      category: `eq.${category}`,
      archived: 'eq.false',
    },
    {
      select:
        'id,code,category,name,price,price_max,price_open_ended,duration_days,notes,applicable_to,sort_order',
      order: 'sort_order.asc',
      limit: 200,
    },
  );
}

/** labor を id 直突合で取得する (cart 積み上げ時の単価確定)。 */
export async function findLaborById(
  env: TrycleRepoEnv,
  laborId: string,
): Promise<Pkg1LaborEntry | null> {
  const rows = await supabaseSelect<Pkg1LaborEntry>(
    env,
    'labor_master',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      id: `eq.${laborId}`,
      archived: 'eq.false',
    },
    {
      select:
        'id,code,category,name,price,price_max,price_open_ended,duration_days,notes,applicable_to,sort_order',
      limit: 1,
    },
  );
  return rows[0] ?? null;
}

/**
 * 指定 labor のオプション (variant・油圧化等) を sort_order 昇順で取得する。
 * (REQ-PKG1-005 variant 併記)
 */
export async function listLaborOptions(
  env: TrycleRepoEnv,
  laborId: string,
): Promise<LaborOption[]> {
  return supabaseSelect<LaborOption>(
    env,
    'labor_options',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      labor_id: `eq.${laborId}`,
      archived: 'eq.false',
    },
    {
      select: 'id,code,name,price,is_default,sort_order,notes',
      order: 'sort_order.asc',
      limit: 50,
    },
  );
}

// ── Case statuses: 新規案件の初期ステータス ──────────────────────────────────

export interface CaseStatusRow {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly sort_order: number;
}

/**
 * tenant の case_statuses を sort_order 昇順で先頭 1 件 (= 新規受付相当) 返す。
 * cases.status_id は NOT NULL なので bot 作成案件の初期ステータスに使う。
 */
export async function findInitialCaseStatus(
  env: TrycleRepoEnv,
): Promise<CaseStatusRow | null> {
  const rows = await supabaseSelect<CaseStatusRow>(
    env,
    'case_statuses',
    { tenant_id: `eq.${getTenantId(env)}` },
    { select: 'id,key,label,sort_order', order: 'sort_order.asc', limit: 1 },
  );
  return rows[0] ?? null;
}

// ── Cases: bot からの新規案件作成 (経路 D) ───────────────────────────────────

export interface InsertCaseInput {
  readonly lineUserId: string;
  readonly customerId: string | null;
  readonly storeId: string | null;
  readonly statusId: string;
  readonly total: number;
  readonly quoteNo: string | null;
  readonly pdfUrl: string | null;
  readonly visitScheduledAt: string | null;
  readonly workNote: string | null;
  readonly chatSummary: string | null;
}

export interface InsertedCase {
  readonly id: string;
}

/**
 * bot_sessions.cart + customer_id で cases 行を新規作成する (経路 D)。
 * 会話履歴の正本は LH 標準 messages_log (D1)。chat_summary は補助の sketch。
 * 戻り値 = 作成された case の id。
 */
export async function insertCase(
  env: TrycleRepoEnv,
  input: InsertCaseInput,
): Promise<InsertedCase> {
  const rows = await supabaseUpsert<InsertedCase>(
    env,
    'cases',
    [
      {
        tenant_id: getTenantId(env),
        customer_id: input.customerId,
        store_id: input.storeId,
        status_id: input.statusId,
        line_user_id: input.lineUserId,
        total: input.total,
        quote_no: input.quoteNo,
        pdf_url: input.pdfUrl,
        visit_scheduled_at: input.visitScheduledAt,
        work_note: input.workNote,
        chat_summary: input.chatSummary,
        updated_at: new Date().toISOString(),
      },
    ],
    { returning: 'representation' },
  );
  const created = rows?.[0];
  if (!created?.id) {
    throw new Error('insertCase: no id returned from cases insert');
  }
  return created;
}

/** 既存 case の来店予定時刻 / total を更新する (経路 D・来店予定確定時)。 */
export async function updateCaseVisit(
  env: TrycleRepoEnv,
  caseId: string,
  visitScheduledAt: string,
): Promise<void> {
  await supabaseUpsert(
    env,
    'cases',
    [
      {
        id: caseId,
        tenant_id: getTenantId(env),
        visit_scheduled_at: visitScheduledAt,
        updated_at: new Date().toISOString(),
      },
    ],
    { onConflict: 'id' },
  );
}
