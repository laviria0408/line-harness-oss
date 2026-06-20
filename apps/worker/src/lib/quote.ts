/**
 * TRYCLE 見積生成ユーティリティ (Phase B-3 port from trycle-line-harness/src/lib/quote.ts).
 *
 * PWA `components/quote-builder.js` の buildQuote ロジック (税 10% / range 合算) を踏襲。
 * 明細は「工賃」のみを扱う。パーツ代は明細化せず PARTS_NOTICE で一括逃げする
 * (REQ-PKG1-007 の運用方針: 店頭で品番・グレード・在庫の確認をしたうえで実額案内)。
 */

export const TAX_RATE = 0.1;

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
  readonly disclaimer: string;
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

export function buildQuote(lineItems: ReadonlyArray<QuoteLineItem>): Quote {
  if (lineItems.length === 0) {
    throw new Error('buildQuote: lineItems must not be empty');
  }
  let subtotal = 0;
  let subtotalMax = 0;
  for (const item of lineItems) {
    subtotal += item.amount;
    subtotalMax += item.amountMax ?? item.amount;
  }
  const tax = Math.floor(subtotal * TAX_RATE);
  const taxMax = Math.floor(subtotalMax * TAX_RATE);
  return {
    lineItems,
    subtotal,
    subtotalMax,
    tax,
    taxMax,
    total: subtotal + tax,
    totalMax: subtotalMax + taxMax,
    disclaimer: ESTIMATE_DISCLAIMER,
  };
}

export function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

export function formatQuoteText(quote: Quote): string {
  const lines: string[] = ['【お見積もり(概算)】', ''];
  for (const item of quote.lineItems) {
    const qtyStr = item.qty > 1 ? ` ×${item.qty}` : '';
    const priceStr =
      item.amountMax !== null && item.amountMax !== item.amount
        ? `${formatYen(item.amount)}〜${formatYen(item.amountMax)}`
        : formatYen(item.amount);
    lines.push(`・${item.name}${qtyStr} ${priceStr}`);
    if (item.notes) {
      lines.push(`  └ ${item.notes}`);
    }
  }
  lines.push('');
  const subtotalStr =
    quote.subtotalMax !== quote.subtotal
      ? `${formatYen(quote.subtotal)}〜${formatYen(quote.subtotalMax)}`
      : formatYen(quote.subtotal);
  const totalStr =
    quote.totalMax !== quote.total
      ? `${formatYen(quote.total)}〜${formatYen(quote.totalMax)}`
      : formatYen(quote.total);
  lines.push(`小計: ${subtotalStr}`);
  lines.push(`消費税(${Math.round(TAX_RATE * 100)}%): ${formatYen(quote.tax)}`);
  lines.push(`合計: ${totalStr}`);
  lines.push('');
  lines.push(quote.disclaimer);
  lines.push('');
  lines.push(PARTS_NOTICE);
  return lines.join('\n');
}
