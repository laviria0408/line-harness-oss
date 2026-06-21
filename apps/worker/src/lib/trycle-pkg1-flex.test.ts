import { describe, it, expect } from 'vitest';
import {
  dispatchPrompt,
  regionMessages,
  symptomMessages,
  variantMessages,
  qtyPrompt,
  cartDecisionPrompt,
  confirmMessages,
  consentPrompt,
  cartSummaryText,
  storeCarousel,
  reservationConfirmPrompt,
  formatVisitAt,
  DISPATCH_LABELS,
} from './trycle-pkg1-flex.js';
import { REGIONS, findRegionByValue } from '../data/pkg1-regions.js';
import { makeLineItem, type QuoteLineItem } from './quote.js';
import type { StoreRow } from './trycle-repo.js';

function serialize(o: unknown): string {
  return JSON.stringify(o);
}

function cart(...items: Partial<QuoteLineItem>[]): QuoteLineItem[] {
  return (items.length ? items : [{}]).map((p) =>
    makeLineItem({ name: 'ブレーキ調整（両側）', unitPrice: 3000, qty: 1, ...p }),
  );
}

// ── Flex 構造ヘルパ (LH 準拠 1 Bubble 縦リスト型の共通検証) ────────────────────

interface FlexLike {
  type: string;
  altText: string;
  contents: { type: string; body?: { contents: unknown[] }; header?: unknown };
}

/** message が Flex Bubble (LH 準拠縦リスト型) であることを assert し、bubble を返す。 */
function expectBubble(msg: unknown): FlexLike['contents'] {
  const m = msg as FlexLike;
  expect(m.type).toBe('flex');
  expect(m.contents.type).toBe('bubble');
  expect(Array.isArray(m.contents.body?.contents)).toBe(true);
  return m.contents;
}

/** Buttons / Carousel テンプレートに退化していないことを保証する (退化防止ガード)。 */
function expectNotTemplate(msg: unknown): void {
  const m = msg as { type: string; template?: unknown };
  expect(m.type).not.toBe('template');
  expect(m.template).toBeUndefined();
}

// ── ① 状況ふりわけ (REQ-002) ─────────────────────────────────────────────────

describe('dispatchPrompt (経路 A・REQ-002)', () => {
  it('renders a Flex bubble (not a template) with the real 3 択 + postbacks', () => {
    const msg = dispatchPrompt();
    expectNotTemplate(msg);
    expectBubble(msg);
    const s = serialize(msg);
    expect(s).toContain('action=pkg1_dispatch&value=identified');
    expect(s).toContain('action=pkg1_dispatch&value=comprehensive');
    expect(s).toContain('action=pkg1_dispatch&value=unknown');
    expect(s).toContain(DISPATCH_LABELS.identified);
    expect(s).toContain('包括メンテしたい');
    expect(s).toContain('原因がわからない');
  });
});

// ── ② 部位 縦リスト (REQ-004) ────────────────────────────────────────────────

describe('regionMessages (経路 B・9 部位 縦リスト)', () => {
  it('renders a single Flex bubble (not carousel) with pkg1_region postbacks', () => {
    const msgs = regionMessages(REGIONS);
    expect(msgs).toHaveLength(1);
    expectNotTemplate(msgs[0]);
    expectBubble(msgs[0]);
    const s = serialize(msgs);
    expect(s).toContain('action=pkg1_region&value=brake');
    expect(s).toContain('action=pkg1_region&value=other');
    expect(s).toContain('オーバーホール関係');
  });
});

// ── ③ 作業 縦リスト (REQ-005) ────────────────────────────────────────────────

describe('symptomMessages (経路 B・縦リスト)', () => {
  it('lists every symptom as a tap row with index-based postbacks', () => {
    const region = findRegionByValue('drivetrain')!;
    const msgs = symptomMessages(region);
    expectNotTemplate(msgs[0]);
    expectBubble(msgs[0]);
    const s = serialize(msgs);
    expect(s).toContain('action=pkg1_symptom&value=0');
    expect(s).toContain('チェーン交換');
  });
});

// ── variant: 縦リスト (排他別単価) ────────────────────────────────────────────

describe('variantMessages', () => {
  it('renders a Flex bubble for ≤4 variants (no buttons template)', () => {
    const symptom = findRegionByValue('brake')!.symptoms![0]; // ブレーキ調整 (2 variants)
    const msg = variantMessages(symptom)[0];
    expectNotTemplate(msg);
    expectBubble(msg);
    expect(serialize(msg)).toContain('action=pkg1_variant&value=0');
  });
  it('renders a Flex bubble for ≥5 variants (no carousel template)', () => {
    const symptom = findRegionByValue('brake')!.symptoms!.find((s) => s.label === 'ブレーキ本体交換')!;
    const msg = variantMessages(symptom)[0];
    expectNotTemplate(msg);
    expectBubble(msg);
    expect(serialize(msg)).toContain('action=pkg1_variant&value=4');
  });
});

// ── qty (v1.2.1: 3 本以上ボタン無し) ──────────────────────────────────────────

describe('qtyPrompt (v1.2.1: 数量制限廃止)', () => {
  it('pair: offers 前後セット / 1本 only (no more button) in a Flex bubble', () => {
    const symptom = { label: 'パンク修理', qty: 'pair' as const };
    const msg = qtyPrompt(symptom);
    expectNotTemplate(msg);
    expectBubble(msg);
    const s = serialize(msg);
    expect(s).toContain('action=pkg1_qty&value=2');
    expect(s).toContain('action=pkg1_qty&value=1');
    expect(s).not.toContain('value=more');
  });
  it('count: offers 1本 / 2本 only and tells user to type a number for 3+', () => {
    const symptom = { label: 'スポーク交換', qty: 'count' as const };
    const s = serialize(qtyPrompt(symptom));
    expect(s).toContain('action=pkg1_qty&value=1');
    expect(s).toContain('action=pkg1_qty&value=2');
    expect(s).not.toContain('value=more');
    expect(s).toContain('数字');
  });
});

// ── cart decision ─────────────────────────────────────────────────────────────

describe('cartDecisionPrompt', () => {
  it('offers add / confirm in a Flex bubble', () => {
    const msg = cartDecisionPrompt();
    expectNotTemplate(msg);
    expectBubble(msg);
    const s = serialize(msg);
    expect(s).toContain('action=pkg1_cart&value=add');
    expect(s).toContain('action=pkg1_cart&value=confirm');
  });
});

// ── confirm: 概算見積 + 3 択 (本物 confirmMessages) ───────────────────────────

describe('confirmMessages (経路 C・REQ-009/011)', () => {
  it('shows the 概算 estimate + 3 択 (pdf_only / reserve / redo) in a Flex bubble', () => {
    const msgs = confirmMessages(cart());
    expect(msgs).toHaveLength(1);
    expectNotTemplate(msgs[0]);
    expectBubble(msgs[0]);
    const s = serialize(msgs);
    expect(s).toContain('概算');
    expect(s).toContain('action=pkg1_confirm&value=pdf_only');
    expect(s).toContain('action=pkg1_confirm&value=reserve');
    expect(s).toContain('action=pkg1_confirm&value=redo');
    expect(s).toContain('PDF だけ受け取る');
    expect(s).toContain('やり直す');
  });
  it('embeds the line item name + total amount in the bubble body', () => {
    const s = serialize(confirmMessages(cart({ name: 'チェーン交換', unitPrice: 2000 })));
    expect(s).toContain('チェーン交換');
    expect(s).toContain('合計');
  });
});

// ── consent (LIFF) ────────────────────────────────────────────────────────────

describe('consentPrompt (経路 D・REQ-016)', () => {
  it('renders the LIFF URL as a uri action in a Flex bubble', () => {
    const msg = consentPrompt('https://liff.line.me/abc');
    expectNotTemplate(msg);
    expectBubble(msg);
    const s = serialize(msg);
    expect(s).toContain('https://liff.line.me/abc');
    expect(s).toContain('uri');
  });
  it('fails loud (準備中) when no LIFF URL and exposes no uri action', () => {
    const msg = consentPrompt(undefined);
    expectNotTemplate(msg);
    expectBubble(msg);
    const s = serialize(msg);
    expect(s).toContain('準備中');
    expect(s).not.toContain('"uri"');
  });
});

// ── store list (経路 D-2) ─────────────────────────────────────────────────────

describe('storeCarousel (経路 D-2・店舗選択 縦リスト)', () => {
  const stores: StoreRow[] = [
    { id: 's1', name: '矢野口本店', code: 'Y', business_hours: {}, reservation_slot_minutes: 30, is_active: true },
    { id: 's2', name: '宮ヶ瀬店', code: 'M', business_hours: {}, reservation_slot_minutes: 30, is_active: true },
  ];
  it('renders one tap row per store with pkg1_reserve_store postbacks in a Flex bubble', () => {
    const msg = storeCarousel(stores);
    expectNotTemplate(msg);
    expectBubble(msg);
    const s = serialize(msg);
    expect(s).toContain('action=pkg1_reserve_store&value=s1');
    expect(s).toContain('action=pkg1_reserve_store&value=s2');
    expect(s).toContain('矢野口本店');
    expect(s).toContain('宮ヶ瀬店');
  });
});

describe('reservationConfirmPrompt', () => {
  it('offers ok / change in a Flex bubble with the human-readable time', () => {
    const msg = reservationConfirmPrompt('矢野口本店', '2026-06-25t14:00');
    expectNotTemplate(msg);
    expectBubble(msg);
    const s = serialize(msg);
    expect(s).toContain('action=pkg1_reserve_confirm&value=ok');
    expect(s).toContain('action=pkg1_reserve_confirm&value=change');
    expect(s).toContain('6/25 14:00');
  });
});

describe('formatVisitAt', () => {
  it('formats a datetimepicker string', () => {
    expect(formatVisitAt('2026-06-25t14:30')).toBe('6/25 14:30');
  });
});

describe('cartSummaryText', () => {
  it('includes a count and the estimate text', () => {
    const text = cartSummaryText(cart({ name: 'チェーン交換', unitPrice: 2000 }));
    expect(text).toContain('カートに追加しました（1件）');
    expect(text).toContain('チェーン交換');
  });
});
