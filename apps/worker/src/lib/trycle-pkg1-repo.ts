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
  readonly price_open_ended: boolean;
  readonly notes: string | null;
}

interface LaborCacheEntry {
  readonly value: Map<string, LaborRow>;
  readonly expiresAt: number;
}

const LABOR_TTL_MS = 5 * 60 * 1000;
const laborCacheByTenant = new Map<string, LaborCacheEntry>();

/**
 * tenant の labor_master を全件取得して code→row の Map を 5 分 cache で返す。
 * dashboard で master 更新 → bot 反映は最大 5 分遅延 (本物と同方針)。
 */
async function loadLaborByCode(env: TrycleRepoEnv): Promise<Map<string, LaborRow>> {
  const tenantId = getTenantId(env);
  const now = Date.now();
  const hit = laborCacheByTenant.get(tenantId);
  if (hit && hit.expiresAt > now) return hit.value;

  const rows = await supabaseSelect<LaborRow>(
    env,
    'labor_master',
    { tenant_id: `eq.${tenantId}`, archived: 'eq.false' },
    {
      select: 'id,code,category,name,price,price_open_ended,notes',
      order: 'sort_order.asc',
      limit: 2000,
    },
  );
  const map = new Map<string, LaborRow>();
  for (const row of rows) map.set(row.code, row);
  laborCacheByTenant.set(tenantId, { value: map, expiresAt: now + LABOR_TTL_MS });
  return map;
}

/** code (= regions.ts の sample) で labor をピンポイント取得する。 */
export async function findLaborByCode(
  env: TrycleRepoEnv,
  code: string,
): Promise<LaborRow | null> {
  const map = await loadLaborByCode(env);
  return map.get(code) ?? null;
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
 * 経路 E (来店時補完): 直近の pdf_only ルート cases を line_user_id で検索し、
 * customer_id 未紐付け (null) のものを返す。なければ null。
 */
export async function findRecentPdfOnlyCase(
  env: TrycleRepoEnv,
  lineUserId: string,
): Promise<{ id: string } | null> {
  const rows = await supabaseSelect<{ id: string }>(
    env,
    'cases',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      line_user_id: `eq.${lineUserId}`,
      customer_id: 'is.null',
    },
    { select: 'id', order: 'created_at.desc', limit: 1 },
  );
  return rows[0] ?? null;
}

/** cases.customer_id を後付け紐付けする (経路 E)。 */
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
