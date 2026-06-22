/**
 * TRYCLE 見積生成ユーティリティ (Phase B-3 port from trycle-line-harness/src/lib/quote.ts).
 *
 * PWA `components/quote-builder.js` の buildQuote ロジック (税 10% / range 合算) を踏襲。
 * 明細は「工賃」のみを扱う。パーツ代は明細化せず PARTS_NOTICE で一括逃げする
 * (REQ-PKG1-007 の運用方針: 店頭で品番・グレード・在庫の確認をしたうえで実額案内)。
 */

/**
 * @deprecated tenant settings (tenants.settings.quote.taxRate) を使う。
 * buildQuote の options 省略時の後方互換 fallback としてのみ残す。
 * dashboard と同じ source of truth (getTenantQuoteSettings) を caller が渡すこと。
 */
export const TAX_RATE = 0.1;

/** buildQuote の options 省略時の後方互換 default (旧挙動: 10% / floor)。 */
const DEFAULT_TAX_RATE = TAX_RATE;
const DEFAULT_TAX_ROUNDING: TaxRounding = 'floor';

export type TaxRounding = 'floor' | 'round' | 'ceil';

/**
 * 端数処理 helper。dashboard 側 `quote-calc.ts:roundBy` と同じセマンティクス。
 *   - floor: 切り捨て / ceil: 切り上げ / round: 四捨五入
 */
export function roundBy(n: number, mode: TaxRounding): number {
  if (mode === 'floor') return Math.floor(n);
  if (mode === 'ceil') return Math.ceil(n);
  return Math.round(n);
}

export interface BuildQuoteOptions {
  /** 税率 (例 0.1)。tenants.settings.quote.taxRate と同じ source of truth。 */
  readonly taxRate: number;
  /** 端数処理。tenants.settings.quote.taxRounding と同じ。 */
  readonly taxRounding: TaxRounding;
}

export const ESTIMATE_DISCLAIMER = '本見積もりは概算です。現物確認後に確定します。';

export const PARTS_NOTICE =
  '※ 部品交換が必要な場合、パーツ代は別途・店頭でご案内します(在庫・グレード・カラーにより変動)。';

export interface QuoteLineItem {
  readonly name: string;
  readonly unitPrice: number;
  readonly unitPriceMax: number | null;
  readonly qty: number;
  readonly amount: number;
  readonly amountMax: number | null;
  readonly notes?: string;
}

export interface Quote {
  readonly lineItems: ReadonlyArray<QuoteLineItem>;
  readonly subtotal: number;
  readonly subtotalMax: number;
  readonly tax: number;
  readonly taxMax: number;
  readonly total: number;
  readonly totalMax: number;
  /**
   * 「上限なし」(unitPriceMax=null) の明細を含むか。
   * true なら合計表示も末尾「〜」付き (¥X〜)。range/固定混在は LINE 上区別しない (UX 優先)。
   */
  readonly hasOpenEnded: boolean;
  readonly disclaimer: string;
  /** この見積に適用した税率 (表示用・dashboard と同じ source of truth)。 */
  readonly taxRate: number;
  /** この見積に適用した端数処理。 */
  readonly taxRounding: TaxRounding;
}

export interface LineItemInput {
  readonly name: string;
  readonly unitPrice: number;
  readonly unitPriceMax?: number | null;
  readonly qty?: number;
  readonly notes?: string;
}

export function makeLineItem(input: LineItemInput): QuoteLineItem {
  const qty = input.qty ?? 1;
  const unitPriceMax = input.unitPriceMax ?? null;
  const amount = input.unitPrice * qty;
  const amountMax = unitPriceMax === null ? null : unitPriceMax * qty;
  return {
    name: input.name,
    unitPrice: input.unitPrice,
    unitPriceMax,
    qty,
    amount,
    amountMax,
    notes: input.notes,
  };
}

/**
 * 見積を組み立てる。
 *
 * @param options 税率・端数処理。省略時は後方互換の { 0.1, "floor" }。
 *   本番経路は `getTenantQuoteSettings(env)` の結果を渡し、dashboard
 *   (設定 > 経理) と同じ source of truth に揃えること。
 */
export function buildQuote(
  lineItems: ReadonlyArray<QuoteLineItem>,
  options?: BuildQuoteOptions,
): Quote {
  if (lineItems.length === 0) {
    throw new Error('buildQuote: lineItems must not be empty');
  }
  const taxRate = options?.taxRate ?? DEFAULT_TAX_RATE;
  const taxRounding = options?.taxRounding ?? DEFAULT_TAX_ROUNDING;
  let subtotal = 0;
  let subtotalMax = 0;
  let hasOpenEnded = false;
  for (const item of lineItems) {
    subtotal += item.amount;
    subtotalMax += item.amountMax ?? item.amount;
    if (item.unitPriceMax === null) hasOpenEnded = true;
  }
  const tax = roundBy(subtotal * taxRate, taxRounding);
  const taxMax = roundBy(subtotalMax * taxRate, taxRounding);
  return {
    lineItems,
    subtotal,
    subtotalMax,
    tax,
    taxMax,
    total: subtotal + tax,
    totalMax: subtotalMax + taxMax,
    hasOpenEnded,
    disclaimer: ESTIMATE_DISCLAIMER,
    taxRate,
    taxRounding,
  };
}

export function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

/**
 * 1 明細の金額表示を整形:
 *   - unitPriceMax === null (上限なし)        → "¥amount〜"        (例: 異音解消 ¥3000〜)
 *   - unitPriceMax あり & amount !== amountMax → "¥amount〜¥amountMax" (range)
 *   - 固定額                                   → "¥amount"
 */
export function formatItemPrice(item: QuoteLineItem): string {
  if (item.unitPriceMax === null) return `${formatYen(item.amount)}〜`;
  if (item.amountMax !== null && item.amountMax !== item.amount) {
    return `${formatYen(item.amount)}〜${formatYen(item.amountMax)}`;
  }
  return formatYen(item.amount);
}

/** 合計表示。open-ended 明細が含まれていれば末尾「〜」。range は "¥a〜¥b"。固定は "¥a"。 */
export function formatTotalPrice(quote: Quote, value: number, valueMax: number): string {
  if (quote.hasOpenEnded) return `${formatYen(value)}〜`;
  if (valueMax !== value) return `${formatYen(value)}〜${formatYen(valueMax)}`;
  return formatYen(value);
}

export function formatQuoteText(quote: Quote): string {
  const lines: string[] = ['【お見積もり(概算)】', ''];
  for (const item of quote.lineItems) {
    const qtyStr = item.qty > 1 ? ` ×${item.qty}` : '';
    lines.push(`・${item.name}${qtyStr} ${formatItemPrice(item)}`);
    if (item.notes) {
      lines.push(`  └ ${item.notes}`);
    }
  }
  lines.push('');
  lines.push(`小計: ${formatTotalPrice(quote, quote.subtotal, quote.subtotalMax)}`);
  lines.push(`消費税(${Math.round(quote.taxRate * 100)}%): ${formatYen(quote.tax)}`);
  lines.push(`合計: ${formatTotalPrice(quote, quote.total, quote.totalMax)}`);
  lines.push('');
  lines.push(quote.disclaimer);
  lines.push('');
  lines.push(PARTS_NOTICE);
  return lines.join('\n');
}
