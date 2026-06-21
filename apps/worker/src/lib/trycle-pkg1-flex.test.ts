import { describe, it, expect } from 'vitest';
import {
  buildEntryBubble,
  buildCategoryBubble,
  buildLaborListBubble,
  buildEstimateBubble,
  buildConsentPromptBubble,
  buildVisitDayBubble,
  categoryLabel,
  priceLabel,
} from './trycle-pkg1-flex.js';
import { buildQuoteFromCart } from './trycle-pkg1.js';
import type { Pkg1LaborEntry } from './trycle-pkg1-repo.js';

// Flex Bubble は JSON.stringify して構造・文言を検証する (LineClient 不要)。
function serialize(o: object): string {
  return JSON.stringify(o);
}

describe('categoryLabel', () => {
  it('maps known codes to Japanese', () => {
    expect(categoryLabel('brake')).toBe('ブレーキ');
    expect(categoryLabel('tire')).toBe('タイヤ・チューブ');
  });
  it('falls back to the raw code for unknown categories', () => {
    expect(categoryLabel('mystery')).toBe('mystery');
  });
});

describe('priceLabel', () => {
  const base: Pkg1LaborEntry = {
    id: 'l', code: 'c', category: 'brake', name: 'n', price: 2000,
    price_max: null, price_open_ended: false, duration_days: null,
    notes: null, applicable_to: [], sort_order: 0,
  };
  it('shows a fixed price', () => {
    expect(priceLabel(base)).toBe('¥2,000');
  });
  it('shows a range when price_max differs', () => {
    expect(priceLabel({ ...base, price_max: 5000 })).toBe('¥2,000〜¥5,000');
  });
  it('shows open-ended with trailing 〜', () => {
    expect(priceLabel({ ...base, price_open_ended: true })).toBe('¥2,000〜');
  });
});

describe('buildEntryBubble (経路 A・REQ-002)', () => {
  it('offers exactly the 3 routing choices', () => {
    const s = serialize(buildEntryBubble());
    expect(s).toContain('pkg1_route_known');
    expect(s).toContain('pkg1_route_staff');
    expect(s).toContain('pkg1_staff_consult');
  });
});

describe('buildCategoryBubble (経路 B・REQ-004)', () => {
  it('renders each category as a postback row', () => {
    const s = serialize(buildCategoryBubble(['brake', 'tire']));
    expect(s).toContain('pkg1_cat_brake');
    expect(s).toContain('pkg1_cat_tire');
    expect(s).toContain('ブレーキ');
  });
});

describe('buildLaborListBubble (経路 B・REQ-005/006)', () => {
  it('shows labor names with prices and a postback per labor', () => {
    const labors: Pkg1LaborEntry[] = [
      {
        id: 'lab1', code: 'brake-pad', category: 'brake', name: 'パッド交換',
        price: 2000, price_max: null, price_open_ended: false, duration_days: null,
        notes: null, applicable_to: [], sort_order: 0,
      },
    ];
    const s = serialize(buildLaborListBubble('brake', labors));
    expect(s).toContain('pkg1_labor_lab1');
    expect(s).toContain('パッド交換');
    expect(s).toContain('¥2,000');
  });
});

describe('buildEstimateBubble (経路 C・REQ-009/010/011)', () => {
  const quote = buildQuoteFromCart([
    {
      labor_id: 'l', code: 'c', name: 'ブレーキ調整', unit_price: 2000,
      unit_price_max: null, qty: 1, option_ids: [], option_names: [], option_total: 0,
    },
  ]);
  it('marks the estimate as 概算 (REQ-009) without an approval button', () => {
    const s = serialize(buildEstimateBubble(quote, '※ パーツ代別途'));
    expect(s).toContain('概算');
    // 承認操作を持たない: 同意ボタン (label に「同意」) は出さない
    expect(s).not.toContain('同意する');
  });
  it('includes the variation note (REQ-010)', () => {
    const s = serialize(buildEstimateBubble(quote, '※ パーツ代別途'));
    expect(s).toContain('状況により変動する場合があります');
  });
  it('offers the visit / staff 2-choice branch (REQ-011)', () => {
    const s = serialize(buildEstimateBubble(quote, ''));
    expect(s).toContain('pkg1_visit_start');
    expect(s).toContain('pkg1_staff_estimate');
  });
});

describe('buildConsentPromptBubble (経路 D・REQ-016)', () => {
  it('renders the LIFF URL as a uri button', () => {
    const s = serialize(buildConsentPromptBubble('https://liff.line.me/abc'));
    expect(s).toContain('https://liff.line.me/abc');
    expect(s).toContain('uri');
  });
});

describe('buildVisitDayBubble (経路 D・REQ-023)', () => {
  it('makes clear this is 来店予定 not a reservation', () => {
    const s = serialize(
      buildVisitDayBubble([{ date: '2026-06-25', label: '6/25 (木)', slots: [] }]),
    );
    expect(s).toContain('pkg1_visit_day_2026-06-25');
    expect(s).toContain('予約ではありません');
  });
});
