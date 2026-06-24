/**
 * TRYCLE Pkg1 (整備見積) 専用 Supabase アクセス層 (本物モデル)。
 *
 * 本物 trycle-line-harness/src/lib/labor-repo.ts + pkg1-estimate.ts の
 * buildLineItemFromPending を port:
 *   - findLaborByCode(env, code): labor_master を code 直突合 (5 分 cache)
 *   - buildLineItemFromPending(env, pending): regions.ts の sample を解決して
 *     QuoteLineItem 1 行を作る (variant ラベル・surcharge・open-ended 「〜」込み)
 * + 見積保存 (v1.2.1 §7 #3): cases + quotes + quote_versions に保存する saveQuote。
 *
 * canonical は Tenant Supabase 直読み (Pkg8 と同方針)。設計: Pkg1 詳細設計 v1.2.1
 * §4 / §5 (page 386050ad6a7e81f8b701cd52c9201af6)。
 */
import { supabaseSelect, supabaseUpsert, supabaseUpdate } from './supabase.js';
import { getTenantId, type TrycleRepoEnv } from './trycle-repo.js';
import { findRegionByValue } from '../data/pkg1-regions.js';
import { makeLineItem, type Quote, type QuoteLineItem } from './quote.js';
import type { PendingSelection } from './trycle-session.js';
import { issueQuoteNo, type QuoteType } from './trycle-quote-number.js';

// ── labor_master: code 直突合 (5 分 cache・本物 labor-repo.ts) ─────────────────

export interface LaborRow {
  readonly id: string;
  readonly code: string;
  readonly category: string;
  readonly name: string;
  readonly price: number;
  /** 上限額 (range 見積)。null = open-ended または固定額 (price_open_ended で区別)。 */
  readonly price_max: number | null;
  readonly price_open_ended: boolean;
  readonly notes: string | null;
  /** お悩み (A1) マッチング用タグ (0028 で追加)。未設定は空配列。 */
  readonly tags: ReadonlyArray<string>;
  /** お悩みマッチング用の説明文 (0028 で追加)。 */
  readonly description: string | null;
}

interface LaborCache {
  /** code → row (既存・variant sample 解決用)。 */
  readonly byCode: Map<string, LaborRow>;
  /** id → row (包括メンテ menu / お悩み候補の解決用)。 */
  readonly byId: Map<string, LaborRow>;
  /** sort_order 昇順の全件 (お悩み trigram スキャン用)。 */
  readonly all: ReadonlyArray<LaborRow>;
}

interface LaborCacheEntry {
  readonly value: LaborCache;
  readonly expiresAt: number;
}

const LABOR_TTL_MS = 5 * 60 * 1000;
const laborCacheByTenant = new Map<string, LaborCacheEntry>();

/** Supabase の生 row (tags/description は null になりうる) を LaborRow に正規化する。 */
function normalizeLaborRow(raw: {
  id: string;
  code: string;
  category: string;
  name: string;
  price: number;
  price_max: number | null;
  price_open_ended: boolean;
  notes: string | null;
  tags: string[] | null;
  description: string | null;
}): LaborRow {
  return {
    id: raw.id,
    code: raw.code,
    category: raw.category,
    name: raw.name,
    price: raw.price,
    price_max: raw.price_max ?? null,
    price_open_ended: raw.price_open_ended,
    notes: raw.notes ?? null,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    description: raw.description ?? null,
  };
}

/**
 * tenant の labor_master を全件取得して code/id Map + 全件配列を 5 分 cache で返す。
 * dashboard で master 更新 → bot 反映は最大 5 分遅延 (本物と同方針)。お悩みマッチング
 * (trycle-labor-search) と包括メンテ menu 解決でこの全件 cache を共有する。
 */
async function loadLaborCache(env: TrycleRepoEnv): Promise<LaborCache> {
  const tenantId = getTenantId(env);
  const now = Date.now();
  const hit = laborCacheByTenant.get(tenantId);
  if (hit && hit.expiresAt > now) return hit.value;

  const rawRows = await supabaseSelect<{
    id: string;
    code: string;
    category: string;
    name: string;
    price: number;
    price_max: number | null;
    price_open_ended: boolean;
    notes: string | null;
    tags: string[] | null;
    description: string | null;
  }>(
    env,
    'labor_master',
    { tenant_id: `eq.${tenantId}`, archived: 'eq.false' },
    {
      select: 'id,code,category,name,price,price_max,price_open_ended,notes,tags,description',
      order: 'sort_order.asc',
      limit: 2000,
    },
  );
  const all = rawRows.map(normalizeLaborRow);
  const byCode = new Map<string, LaborRow>();
  const byId = new Map<string, LaborRow>();
  for (const row of all) {
    byCode.set(row.code, row);
    byId.set(row.id, row);
  }
  const cache: LaborCache = { byCode, byId, all };
  laborCacheByTenant.set(tenantId, { value: cache, expiresAt: now + LABOR_TTL_MS });
  return cache;
}

// ── labor_options: 親 labor に紐付く追加オプション (1:N・migration 0010/0031) ──

/**
 * 親 labor_master の追加オプション 1 行 (migration 0010_supabase_unified_master)。
 * 旧 PWA estimate.js の optionalPartCategories を labor_options ベースに簡略化した
 * もの (Pkg1 variant/menu 確定後に順次「追加しますか?」と問う対象)。
 *   - price=0 + notes（例「お見積もり要相談」） は「金額未確定の要相談オプション」。
 *     line item には金額 0 で積みつつ notes を残す (スタッフが店頭で確定する)。
 */
export interface LaborOptionRow {
  readonly id: string;
  readonly laborId: string;
  readonly code: string;
  readonly name: string;
  readonly price: number;
  readonly isDefault: boolean;
  readonly notes: string | null;
  readonly sortOrder: number;
}

interface LaborOptionRaw {
  id: string;
  labor_id: string;
  code: string;
  name: string;
  price: number;
  is_default: boolean;
  notes: string | null;
  sort_order: number;
}

function normalizeLaborOption(raw: LaborOptionRaw): LaborOptionRow {
  return {
    id: raw.id,
    laborId: raw.labor_id,
    code: raw.code,
    name: raw.name,
    price: typeof raw.price === 'number' ? raw.price : 0,
    isDefault: raw.is_default === true,
    notes: raw.notes ?? null,
    sortOrder: typeof raw.sort_order === 'number' ? raw.sort_order : 0,
  };
}

/**
 * 親 labor_id に紐付く有効な labor_options を sort_order 昇順で返す。
 * archived は除外。オプションが無いメニューは空配列 (= 順次問いを skip)。
 *
 * 旧 PWA の parts_master 連動 (optionalPartCategories) は廃止し、labor_options を
 * そのまま「追加しますか?」の選択肢に使う (簡略化方針・task 20260625-004)。
 */
export async function listLaborOptions(
  env: TrycleRepoEnv,
  laborId: string,
): Promise<LaborOptionRow[]> {
  if (!laborId) return [];
  const rawRows = await supabaseSelect<LaborOptionRaw>(
    env,
    'labor_options',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      labor_id: `eq.${laborId}`,
      archived: 'eq.false',
    },
    {
      select: 'id,labor_id,code,name,price,is_default,notes,sort_order',
      order: 'sort_order.asc',
      limit: 100,
    },
  );
  return rawRows.map(normalizeLaborOption);
}

/**
 * labor_options 1 行から QuoteLineItem を作る (オプションを cart 明細へ積むときに使う)。
 *   - unitPrice = option.price (要相談オプションは 0)
 *   - notes     = option.notes（あれば。例「お見積もり要相談」を明細に残す）
 *   - name 末尾に「（オプション）」は付けない (notes 側で区別・PDF 表記をシンプルに)
 */
export function laborOptionToLineItem(option: LaborOptionRow): QuoteLineItem {
  return makeLineItem({
    name: option.name,
    unitPrice: option.price,
    unitPriceMax: option.price,
    qty: 1,
    ...(option.notes ? { notes: option.notes } : {}),
  });
}

/** code (= regions.ts の sample) で labor をピンポイント取得する。 */
export async function findLaborByCode(
  env: TrycleRepoEnv,
  code: string,
): Promise<LaborRow | null> {
  const cache = await loadLaborCache(env);
  return cache.byCode.get(code) ?? null;
}

/** id (uuid) で labor をピンポイント取得する (包括メンテ menu / お悩み候補の解決用)。 */
export async function findLaborById(
  env: TrycleRepoEnv,
  id: string,
): Promise<LaborRow | null> {
  const cache = await loadLaborCache(env);
  return cache.byId.get(id) ?? null;
}

/** tenant の labor_master 全件 (sort_order 昇順) を返す (お悩み trigram スキャン用)。 */
export async function loadAllLabor(env: TrycleRepoEnv): Promise<ReadonlyArray<LaborRow>> {
  const cache = await loadLaborCache(env);
  return cache.all;
}

/**
 * labor_master 1 行から QuoteLineItem を作る (qty 適用前)。包括メンテ menu / お悩み
 * 候補の確定で使う (buildLineItemFromPending の labor→item 部分を共有)。
 *   - unitPrice    = labor.price
 *   - unitPriceMax = open-ended → null / price_max あり → price_max / 固定 → price
 */
export function laborToLineItem(labor: LaborRow): QuoteLineItem {
  const unitPriceMax = labor.price_open_ended
    ? null
    : labor.price_max ?? labor.price;
  return makeLineItem({
    name: labor.name,
    unitPrice: labor.price,
    unitPriceMax,
    qty: 1,
    ...(labor.notes ? { notes: labor.notes } : {}),
  });
}

/** テスト用: labor cache をクリアする。 */
export function resetLaborCache(): void {
  laborCacheByTenant.clear();
}

// ── 明細組み立て (本物 buildLineItemFromPending) ──────────────────────────────

/**
 * pending(region/symptom/variant index) → sample(labor code) を解決し、
 * labor_master の単価を引いて QuoteLineItem 1 行 (qty 適用前) を作る。
 *
 *   - name      = `{labor.name}（{variant.label}）{priceOpenEnded?'〜':''}`
 *   - unitPrice = labor.price + (variant.surcharge?.amount ?? 0)
 *   - notes     = labor.notes / surcharge を併記
 *
 * sample=null (その他) や labor 解決不能なら null (呼び出し側でスタッフ送り)。
 * qty はここでは扱わず、呼び出し側 (onQty) が makeLineItem で掛ける。
 */
export async function buildLineItemFromPending(
  env: TrycleRepoEnv,
  pending: PendingSelection | undefined,
): Promise<QuoteLineItem | null> {
  if (!pending) return null;
  const region = findRegionByValue(pending.regionValue);
  const symptom = region?.symptoms?.[pending.symptomIndex];
  if (!symptom) return null;

  const variant =
    pending.variantIndex !== undefined ? symptom.variants?.[pending.variantIndex] : undefined;
  const sample = variant ? variant.sample : symptom.sample;
  if (!sample) return null;

  let labor: LaborRow | null = null;
  try {
    labor = await findLaborByCode(env, sample);
  } catch (err) {
    console.warn('[trycle-pkg1-repo] findLaborByCode failed', err);
  }
  if (!labor) {
    // No labor row for this sample code → caller escalates to staff. Logging the
    // missing code makes a labor_master gap (vs Supabase outage) diagnosable.
    console.error('[trycle-pkg1-repo] buildLineItemFromPending: no labor_master row for code', sample);
    return null;
  }

  const variantLabel = variant ? `（${variant.label}）` : '';
  const surcharge = variant?.surcharge;
  const notesParts: string[] = [];
  if (labor.notes) notesParts.push(labor.notes);
  if (surcharge) notesParts.push(`${surcharge.name} +¥${surcharge.amount.toLocaleString('ja-JP')}`);

  const unitPrice = labor.price + (surcharge?.amount ?? 0);
  return makeLineItem({
    // 名前末尾の "〜" は廃止 (旧仕様)。金額側 (formatItemPrice) で「¥X〜」を出すため
    // 名前にも付くと二重表示になる。Open-ended は unitPriceMax=null で表現する。
    name: `${labor.name}${variantLabel}`,
    unitPrice,
    // 上限なし (異音解消等) は unitPriceMax=null → "¥X〜" 表示。固定額は unitPrice と
    // 同値 → "¥X" 表示。range (上下違う) を表現したい場合は別途上限値を渡す (現状 master
    // には range 列が無いので open_ended/固定 の 2 値運用)。
    unitPriceMax: labor.price_open_ended ? null : unitPrice,
    qty: 1,
    ...(notesParts.length ? { notes: notesParts.join(' / ') } : {}),
  });
}

// ── case_statuses: 新規案件の初期ステータス ──────────────────────────────────

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
export async function findInitialCaseStatus(env: TrycleRepoEnv): Promise<CaseStatusRow | null> {
  const rows = await supabaseSelect<CaseStatusRow>(
    env,
    'case_statuses',
    { tenant_id: `eq.${getTenantId(env)}` },
    { select: 'id,key,label,sort_order', order: 'sort_order.asc', limit: 1 },
  );
  return rows[0] ?? null;
}

/**
 * 経路ごとに status を振り分ける用 (PDF only → 'pdf_only' / 来店予定 → 'visit_scheduled' 等)。
 * 一致が無ければ null。呼び出し側で findInitialCaseStatus に fallback する。
 */
export async function findCaseStatusByKey(
  env: TrycleRepoEnv,
  key: string,
): Promise<CaseStatusRow | null> {
  const rows = await supabaseSelect<CaseStatusRow>(
    env,
    'case_statuses',
    { tenant_id: `eq.${getTenantId(env)}`, key: `eq.${key}` },
    { select: 'id,key,label,sort_order', limit: 1 },
  );
  return rows[0] ?? null;
}

// ── stores: 採番に使う code 解決 ──────────────────────────────────────────────

/** 先頭の有効店舗 (id + code) を返す。pdf_only の見積保存の既定店舗に使う。 */
export async function findDefaultStore(
  env: TrycleRepoEnv,
): Promise<{ id: string; code: string } | null> {
  const rows = await supabaseSelect<{ id: string; code: string | null }>(
    env,
    'stores',
    { tenant_id: `eq.${getTenantId(env)}`, is_active: 'eq.true' },
    { select: 'id,code', order: 'sort_order.asc', limit: 1 },
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, code: row.code ?? 'Y' };
}

export async function findStoreCode(env: TrycleRepoEnv, storeId: string): Promise<string> {
  const rows = await supabaseSelect<{ code: string | null }>(
    env,
    'stores',
    { tenant_id: `eq.${getTenantId(env)}`, id: `eq.${storeId}` },
    { select: 'code', limit: 1 },
  );
  return rows[0]?.code ?? 'Y';
}

// ── cases + quotes + quote_versions 保存 (v1.2.1 §7 #3) ───────────────────────

export interface SaveQuoteInput {
  readonly lineUserId: string;
  readonly customerId: string | null;
  readonly storeId: string;
  readonly storeCode: string;
  readonly statusId: string;
  readonly quote: Quote;
  /** 'pdf_only' (見積発行のみ) / 来店予定 等。cases.work_note 補助。 */
  readonly caseLabel: string;
  readonly visitScheduledAt: string | null;
  readonly chatSummary: string | null;
}

export interface SavedQuote {
  readonly caseId: string;
  readonly quoteId: string;
  readonly quoteVersionId: string;
  readonly quoteNo: string;
}

interface InsertedRow {
  readonly id: string;
}

/**
 * cases → quotes → quote_versions を順に作成し、quotes.current_version_id を
 * UPDATE する (dashboard の見積保存と同じ relation)。見積番号は採番ロジック流用。
 *
 * 失敗は throw する (呼び出し側で graceful にユーザーへ案内)。pdf_url は別途
 * updateQuotePdfUrl で後追い更新する。
 */
export async function saveQuote(env: TrycleRepoEnv, input: SaveQuoteInput): Promise<SavedQuote> {
  const tenantId = getTenantId(env);
  const quoteType: QuoteType = 'estimate';

  // 1) cases
  const caseRows = await supabaseUpsert<InsertedRow>(
    env,
    'cases',
    [
      {
        tenant_id: tenantId,
        customer_id: input.customerId,
        store_id: input.storeId,
        status_id: input.statusId,
        line_user_id: input.lineUserId,
        total: input.quote.total,
        visit_scheduled_at: input.visitScheduledAt,
        work_note: input.caseLabel,
        chat_summary: input.chatSummary,
        updated_at: new Date().toISOString(),
      },
    ],
    { returning: 'representation' },
  );
  const caseId = caseRows?.[0]?.id;
  if (!caseId) throw new Error('saveQuote: cases insert returned no id');

  // 2) 見積番号採番
  const issued = await issueQuoteNo(env, {
    storeId: input.storeId,
    storeCode: input.storeCode,
    quoteType,
  });

  // 3) quotes
  const quoteRows = await supabaseUpsert<InsertedRow>(
    env,
    'quotes',
    [
      {
        tenant_id: tenantId,
        case_id: caseId,
        store_id: input.storeId,
        quote_type: quoteType,
        fy_year: issued.fyYear,
        seq_no: issued.seqNo,
        updated_at: new Date().toISOString(),
      },
    ],
    { returning: 'representation' },
  );
  const quoteId = quoteRows?.[0]?.id;
  if (!quoteId) throw new Error('saveQuote: quotes insert returned no id');

  // 4) quote_versions (payload_json = cart/quote snapshot)
  const versionRows = await supabaseUpsert<InsertedRow>(
    env,
    'quote_versions',
    [
      {
        quote_id: quoteId,
        version: issued.version,
        quote_no: issued.quoteNo,
        payload_json: buildQuotePayload(input),
        subtotal: input.quote.subtotal,
        total_discount: 0,
        taxable: input.quote.subtotal,
        tax: input.quote.tax,
        total: input.quote.total,
      },
    ],
    { returning: 'representation' },
  );
  const quoteVersionId = versionRows?.[0]?.id;
  if (!quoteVersionId) throw new Error('saveQuote: quote_versions insert returned no id');

  // 5) quotes.current_version_id + cases.quote_no を最新版に紐付け
  // UPSERT は INSERT 試行を伴うため、case_id 等の NOT NULL 列が無いと 23502 違反になる。
  // ここは既存行の UPDATE しか想定していないので PATCH (supabaseUpdate) を使う。
  await supabaseUpdate(
    env,
    'quotes',
    { id: `eq.${quoteId}`, tenant_id: `eq.${tenantId}` },
    { current_version_id: quoteVersionId, updated_at: new Date().toISOString() },
  );
  await supabaseUpdate(
    env,
    'cases',
    { id: `eq.${caseId}`, tenant_id: `eq.${tenantId}` },
    { quote_no: issued.quoteNo, updated_at: new Date().toISOString() },
  );

  return { caseId, quoteId, quoteVersionId, quoteNo: issued.quoteNo };
}

// ── cases 単体保存 (見積なし・来店予定ゲート Phase 4) ─────────────────────────

export interface SaveVisitCaseInput {
  readonly lineUserId: string;
  readonly customerId: string | null;
  readonly storeId: string | null;
  readonly statusId: string;
  /** 既定担当者 (stores.default_assignee_id)。未設定なら null。 */
  readonly assigneeId: string | null;
  /** "...+09:00" 形式の来店日時 (timestamptz)。 */
  readonly visitScheduledAt: string | null;
  /** cases.work_note 補助 (例 '来店予定 (各種予約)')。 */
  readonly caseLabel: string;
  /** cases.chat_summary 初期値 (通常 null・flush helper が後で移す)。 */
  readonly chatSummary: string | null;
}

/**
 * 見積を伴わない来店予約 case を 1 件作成する (来店予定ゲート Phase 4)。Pkg1 の
 * saveQuote と違い quotes / quote_versions は作らず cases 1 行のみ insert する
 * (buildQuote は空 cart で throw するため見積経路を流用できない)。assignee_id は
 * 店舗の既定担当者を入れる (nullable・migration 0011)。失敗は throw (呼び出し側で
 * graceful 案内)。
 */
export async function saveVisitOnlyCase(
  env: TrycleRepoEnv,
  input: SaveVisitCaseInput,
): Promise<{ caseId: string }> {
  const tenantId = getTenantId(env);
  const caseRows = await supabaseUpsert<InsertedRow>(
    env,
    'cases',
    [
      {
        tenant_id: tenantId,
        customer_id: input.customerId,
        store_id: input.storeId,
        status_id: input.statusId,
        assignee_id: input.assigneeId,
        line_user_id: input.lineUserId,
        visit_scheduled_at: input.visitScheduledAt,
        work_note: input.caseLabel,
        chat_summary: input.chatSummary,
        updated_at: new Date().toISOString(),
      },
    ],
    { returning: 'representation' },
  );
  const caseId = caseRows?.[0]?.id;
  if (!caseId) throw new Error('saveVisitOnlyCase: cases insert returned no id');
  return { caseId };
}

/** PDF 発行後に cases.pdf_url / quote_versions.pdf_url を更新する。 */
export async function updateQuotePdfUrl(
  env: TrycleRepoEnv,
  saved: { caseId: string; quoteVersionId: string },
  pdfUrl: string,
): Promise<void> {
  const tenantId = getTenantId(env);
  await supabaseUpsert(
    env,
    'cases',
    [{ id: saved.caseId, tenant_id: tenantId, pdf_url: pdfUrl, updated_at: new Date().toISOString() }],
    { onConflict: 'id' },
  );
  await supabaseUpsert(
    env,
    'quote_versions',
    [{ id: saved.quoteVersionId, pdf_url: pdfUrl }],
    { onConflict: 'id' },
  );
}

/**
 * cases.customer_id を後付け紐付けする (経路 E・単件)。
 * 経路 E 拡張で通常は attachCustomerIdToAllNullCases (全件) を使うが、
 * 単件紐付けが必要な呼び出し向けに残す。
 */
export async function linkCaseCustomer(
  env: TrycleRepoEnv,
  caseId: string,
  customerId: string,
): Promise<void> {
  await supabaseUpsert(
    env,
    'cases',
    [
      {
        id: caseId,
        tenant_id: getTenantId(env),
        customer_id: customerId,
        updated_at: new Date().toISOString(),
      },
    ],
    { onConflict: 'id' },
  );
}

// 1 顧客あたりの未紐付け case 後付けは現実的にはごく少数。事故的な大量 UPDATE を
// 避けるための安全キャップ。これを超える場合は別途調査すべき異常。
const ATTACH_ALL_NULL_CASES_LIMIT = 20;

/**
 * 経路 E 拡張 (ユーザ確定仕様): 同 tenant + 同 line_user_id で customer_id 未紐付け
 * (null) の cases を全件取得し、今登録した customer を後付け紐付けする。
 *
 * ケース ① (PDF → 来店予約) / ③ (PDF 複数 → LIFF) で、過去の pdf_only case が
 * 複数 customer_id=null のまま残るのを解消する。既に customer_id が入っている case は
 * フィルタ (is.null) で対象外になるため idempotent (二重 update しない)。
 *
 * @returns 後付け紐付けした件数
 */
export async function attachCustomerIdToAllNullCases(
  env: TrycleRepoEnv,
  customerId: string,
  lineUserId: string,
): Promise<number> {
  const tenantId = getTenantId(env);
  const rows = await supabaseSelect<{ id: string }>(
    env,
    'cases',
    {
      tenant_id: `eq.${tenantId}`,
      line_user_id: `eq.${lineUserId}`,
      customer_id: 'is.null',
    },
    { select: 'id', order: 'created_at.desc', limit: ATTACH_ALL_NULL_CASES_LIMIT },
  );
  if (rows.length === 0) return 0;

  // line_user_id + customer_id IS NULL を条件に 1 回の PATCH で全件 update する
  // (PostgREST は filter 全行を更新)。既に紐付け済の case は is.null フィルタで除外。
  await supabaseUpdate(
    env,
    'cases',
    {
      tenant_id: `eq.${tenantId}`,
      line_user_id: `eq.${lineUserId}`,
      customer_id: 'is.null',
    },
    { customer_id: customerId, updated_at: new Date().toISOString() },
  );
  return rows.length;
}

/**
 * quote_versions.payload_json のスナップショット。dashboard QuotePayload の
 * 最小サブセット (bot は工賃明細のみ・パーツ/割引なし)。会話の cart を保持する。
 */
function buildQuotePayload(input: SaveQuoteInput): Record<string, unknown> {
  return {
    source: 'line_bot_pkg1',
    line_user_id: input.lineUserId,
    items: input.quote.lineItems.map((li) => ({
      kind: 'labor',
      name: li.name,
      unitPrice: li.unitPrice,
      unitPriceMax: li.unitPriceMax,
      qty: li.qty,
      amount: li.amount,
      amountMax: li.amountMax,
      notes: li.notes ?? null,
    })),
    discount: { type: 'none' },
    subtotal: input.quote.subtotal,
    subtotalMax: input.quote.subtotalMax,
    tax: input.quote.tax,
    total: input.quote.total,
    totalMax: input.quote.totalMax,
    disclaimer: input.quote.disclaimer,
  };
}
