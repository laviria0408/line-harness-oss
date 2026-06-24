/**
 * 包括メンテ (A2・v1.6) Flex builders の純関数テスト。
 * 料金/納期 表記と carousel / matrix の構造を検証する。
 */
import { describe, it, expect } from 'vitest';
import {
  formatMenuPrice,
  formatMenuDuration,
  overhaulMenuCarousel,
  overhaulMenuPicker,
  overhaulMatrixMessages,
  buildMatrixAltText,
  overhaulEntryActions,
  TRYCLE_ORANGE,
} from './trycle-overhaul-flex.js';
import type { OverhaulMenu, OverhaulMenuMatrix } from './trycle-overhaul-repo.js';

function menu(over: Partial<OverhaulMenu> = {}): OverhaulMenu {
  return {
    laborId: 'lm-1',
    code: 'oh-premium',
    name: 'オーバーホール プレミアム',
    price: 80000,
    priceMax: null,
    priceOpenEnded: false,
    durationDaysMin: 14,
    durationDaysMax: 20,
    detailedDescription: '全バラシのコースです。',
    heroImageUrl: null,
    sortOrder: 0,
    ...over,
  };
}

describe('formatMenuPrice', () => {
  it('固定額', () => {
    expect(formatMenuPrice({ price: 80000, priceMax: null, priceOpenEnded: false })).toBe('¥80,000');
  });
  it('open-ended → 〜', () => {
    expect(formatMenuPrice({ price: 80000, priceMax: null, priceOpenEnded: true })).toBe('¥80,000〜');
  });
  it('range → ¥a〜¥b', () => {
    expect(formatMenuPrice({ price: 80000, priceMax: 120000, priceOpenEnded: false })).toBe('¥80,000〜¥120,000');
  });
  it('priceMax === price は固定額扱い', () => {
    expect(formatMenuPrice({ price: 80000, priceMax: 80000, priceOpenEnded: false })).toBe('¥80,000');
  });
});

describe('formatMenuDuration', () => {
  it('0-0 → 当日', () => {
    expect(formatMenuDuration({ durationDaysMin: 0, durationDaysMax: 0 })).toBe('当日');
  });
  it('range', () => {
    expect(formatMenuDuration({ durationDaysMin: 14, durationDaysMax: 20 })).toBe('14〜20日');
  });
  it('min===max', () => {
    expect(formatMenuDuration({ durationDaysMin: 3, durationDaysMax: 3 })).toBe('3日');
  });
  it('null/null → 店頭でご案内', () => {
    expect(formatMenuDuration({ durationDaysMin: null, durationDaysMax: null })).toBe('店頭でご案内');
  });
});

describe('overhaulMenuCarousel', () => {
  it('builds a carousel with one bubble per menu + orange header', () => {
    const msg = overhaulMenuCarousel([menu(), menu({ laborId: 'lm-2', code: 'oh-standard', name: 'スタンダード' })]);
    const s = JSON.stringify(msg);
    expect(msg.type).toBe('flex');
    expect((msg.contents as { type: string }).type).toBe('carousel');
    expect((msg.contents as { contents: unknown[] }).contents.length).toBe(2);
    expect(s).toContain(TRYCLE_ORANGE);
    // 各メニューに確定 postback。
    expect(s).toContain('action=pkg1_overhaul_menu&value=lm-1');
    expect(s).toContain('¥80,000');
    expect(s).toContain('14〜20日');
  });
  it('inserts hero image only when heroImageUrl is set', () => {
    const withHero = JSON.stringify(overhaulMenuCarousel([menu({ heroImageUrl: 'https://x/y.png' })]));
    const without = JSON.stringify(overhaulMenuCarousel([menu({ heroImageUrl: null })]));
    expect(withHero).toContain('"hero"');
    expect(without).not.toContain('"hero"');
  });
});

describe('overhaulEntryActions / overhaulMenuPicker', () => {
  it('entry actions expose picker + matrix postbacks', () => {
    const s = JSON.stringify(overhaulEntryActions());
    expect(s).toContain('action=pkg1_overhaul&value=picker');
    expect(s).toContain('action=pkg1_overhaul&value=matrix');
  });
  it('picker lists one row per menu', () => {
    const s = JSON.stringify(overhaulMenuPicker([menu(), menu({ laborId: 'lm-2' })]));
    expect(s).toContain('action=pkg1_overhaul_menu&value=lm-1');
    expect(s).toContain('action=pkg1_overhaul_menu&value=lm-2');
  });
});

describe('overhaulMatrixMessages / buildMatrixAltText', () => {
  const matrix: OverhaulMenuMatrix[] = [
    {
      menu: menu(),
      includedFeatures: ['分解・洗浄・組み立て', '各部トルクチェック'],
      optionalFeatures: [{ featureName: '油圧ホース交換', priceLabel: '¥12,000' }],
    },
  ];

  it('builds a per-menu card carousel with included + optional features', () => {
    const msgs = overhaulMatrixMessages(matrix);
    const s = JSON.stringify(msgs);
    expect(msgs.length).toBe(1);
    expect(s).toContain('分解・洗浄・組み立て');
    expect(s).toContain('各部トルクチェック');
    expect(s).toContain('油圧ホース交換');
    expect(s).toContain('¥12,000');
    // 案 A 補足 (altText) にメニュー名が出る。
    expect(msgs[0].altText).toContain('オーバーホール プレミアム');
  });

  it('altText summarizes counts and stays within LINE limit', () => {
    const alt = buildMatrixAltText(matrix);
    expect(alt).toContain('含まれる内容: 2項目');
    expect(alt).toContain('オプション1項目');
    expect(alt.length).toBeLessThanOrEqual(400);
  });
});
