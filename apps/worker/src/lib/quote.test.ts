import { describe, it, expect } from 'vitest';
import {
  buildQuote,
  formatQuoteText,
  formatYen,
  makeLineItem,
  TAX_RATE,
  type QuoteLineItem,
} from './quote.js';

describe('makeLineItem', () => {
  it('computes amount = unitPrice × qty when qty omitted', () => {
    const item = makeLineItem({ name: 'ブレーキ調整', unitPrice: 3000 });
    expect(item.qty).toBe(1);
    expect(item.amount).toBe(3000);
    expect(item.amountMax).toBeNull();
  });

  it('handles unitPriceMax range', () => {
    const item = makeLineItem({
      name: 'スポーク交換',
      unitPrice: 5000,
      unitPriceMax: 10000,
      qty: 2,
    });
    expect(item.amount).toBe(10000);
    expect(item.amountMax).toBe(20000);
  });
});

describe('buildQuote', () => {
  it('throws when lineItems is empty', () => {
    expect(() => buildQuote([])).toThrow(/must not be empty/);
  });

  it('sums amounts, applies tax rate, returns range when max present', () => {
    const items: QuoteLineItem[] = [
      makeLineItem({ name: 'A', unitPrice: 1000 }),
      makeLineItem({ name: 'B', unitPrice: 2000, unitPriceMax: 3000 }),
    ];
    const quote = buildQuote(items);
    expect(quote.subtotal).toBe(3000);
    expect(quote.subtotalMax).toBe(4000);
    expect(quote.tax).toBe(Math.floor(3000 * TAX_RATE));
    expect(quote.taxMax).toBe(Math.floor(4000 * TAX_RATE));
    expect(quote.total).toBe(3300);
    expect(quote.totalMax).toBe(4400);
  });

  it('disclaimer is the canonical 概算 message', () => {
    const quote = buildQuote([makeLineItem({ name: 'X', unitPrice: 100 })]);
    expect(quote.disclaimer).toMatch(/概算/);
  });
});

describe('formatYen', () => {
  it('formats with comma + ¥ prefix', () => {
    expect(formatYen(1500000)).toBe('¥1,500,000');
  });
});

describe('formatQuoteText', () => {
  it('includes header, line items, totals, disclaimer, and parts notice', () => {
    const quote = buildQuote([
      makeLineItem({ name: 'ブレーキ調整 (両側)', unitPrice: 3000 }),
    ]);
    const text = formatQuoteText(quote);
    expect(text).toContain('【お見積もり(概算)】');
    expect(text).toContain('ブレーキ調整 (両側)');
    expect(text).toContain('¥3,000');
    expect(text).toContain('合計: ¥3,300');
    expect(text).toContain('概算');
    expect(text).toContain('パーツ代は別途');
  });

  it('renders range total when amountMax differs', () => {
    const items: QuoteLineItem[] = [
      makeLineItem({ name: 'X', unitPrice: 1000, unitPriceMax: 2000 }),
    ];
    const text = formatQuoteText(buildQuote(items));
    expect(text).toMatch(/合計: ¥1,100〜¥2,200/);
  });

  it('emits qty suffix and notes when present', () => {
    const items: QuoteLineItem[] = [
      makeLineItem({
        name: 'チューブ交換',
        unitPrice: 1500,
        qty: 2,
        notes: 'バルブ追加 +¥200',
      }),
    ];
    const text = formatQuoteText(buildQuote(items));
    expect(text).toContain('×2');
    expect(text).toContain('└ バルブ追加 +¥200');
  });
});
