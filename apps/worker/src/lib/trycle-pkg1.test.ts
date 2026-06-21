/**
 * Pkg1 整備見積 — pure-function tests (cart / quote / cart summary).
 * postback/Supabase 連携は trycle-pkg1-flex.test.ts / trycle-session.test.ts で分担。
 */
import { describe, it, expect } from 'vitest';
import { buildCartItem, buildQuoteFromCart, cartSummaryText } from './trycle-pkg1.js';
import type { Pkg1LaborEntry } from './trycle-pkg1-repo.js';
import type { CartItem } from './trycle-session.js';

function labor(overrides: Partial<Pkg1LaborEntry> = {}): Pkg1LaborEntry {
  return {
    id: 'labor-1',
    code: 'brake-pad-swap',
    category: 'brake',
    name: 'ブレーキパッド交換',
    price: 2000,
    price_max: null,
    price_open_ended: false,
    duration_days: null,
    notes: null,
    applicable_to: ['all'],
    sort_order: 0,
    ...overrides,
  };
}

describe('buildCartItem', () => {
  it('builds an item with no options', () => {
    const item = buildCartItem(labor(), []);
    expect(item.labor_id).toBe('labor-1');
    expect(item.unit_price).toBe(2000);
    expect(item.option_total).toBe(0);
    expect(item.option_ids).toEqual([]);
    expect(item.qty).toBe(1);
  });

  it('sums option prices into option_total and keeps names', () => {
    const item = buildCartItem(labor(), [
      { id: 'opt-1', name: '油圧化', price: 1500 },
      { id: 'opt-2', name: 'フル内装', price: 800 },
    ]);
    expect(item.option_total).toBe(2300);
    expect(item.option_names).toEqual(['油圧化', 'フル内装']);
    expect(item.option_ids).toEqual(['opt-1', 'opt-2']);
  });

  it('carries price_max for range items', () => {
    const item = buildCartItem(labor({ price: 3000, price_max: 5000 }), []);
    expect(item.unit_price_max).toBe(5000);
  });
});

function cartItem(overrides: Partial<CartItem> = {}): CartItem {
  return {
    labor_id: 'l1',
    code: 'c1',
    name: '作業A',
    unit_price: 2000,
    unit_price_max: null,
    qty: 1,
    option_ids: [],
    option_names: [],
    option_total: 0,
    ...overrides,
  };
}

describe('buildQuoteFromCart', () => {
  it('applies 10% tax to a single fixed-price item', () => {
    const quote = buildQuoteFromCart([cartItem({ unit_price: 2000 })]);
    expect(quote.subtotal).toBe(2000);
    expect(quote.tax).toBe(200);
    expect(quote.total).toBe(2200);
    expect(quote.total).toBe(quote.totalMax); // no range
  });

  it('adds option_total into the unit price', () => {
    const quote = buildQuoteFromCart([
      cartItem({ unit_price: 2000, option_total: 1500, option_names: ['油圧化'] }),
    ]);
    expect(quote.subtotal).toBe(3500);
    expect(quote.total).toBe(3850);
    expect(quote.lineItems[0]!.name).toContain('油圧化');
  });

  it('produces a range total when price_max is set', () => {
    const quote = buildQuoteFromCart([
      cartItem({ unit_price: 3000, unit_price_max: 5000 }),
    ]);
    expect(quote.subtotal).toBe(3000);
    expect(quote.subtotalMax).toBe(5000);
    expect(quote.total).toBe(3300);
    expect(quote.totalMax).toBe(5500);
  });

  it('respects qty', () => {
    const quote = buildQuoteFromCart([cartItem({ unit_price: 1000, qty: 3 })]);
    expect(quote.subtotal).toBe(3000);
  });

  it('sums multiple items', () => {
    const quote = buildQuoteFromCart([
      cartItem({ unit_price: 2000 }),
      cartItem({ unit_price: 1500, option_total: 500 }),
    ]);
    expect(quote.subtotal).toBe(4000);
    expect(quote.total).toBe(4400);
  });
});

describe('cartSummaryText', () => {
  it('lists items with options and a subtotal', () => {
    const text = cartSummaryText([
      cartItem({ name: 'ブレーキ調整', unit_price: 2000 }),
      cartItem({ name: 'タイヤ交換', unit_price: 1500, option_total: 500, option_names: ['チューブレス'] }),
    ]);
    expect(text).toContain('・ブレーキ調整');
    expect(text).toContain('・タイヤ交換 (チューブレス)');
    expect(text).toContain('小計(税抜): 4000円');
  });
});
