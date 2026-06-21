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
  reservationSlotMessages,
  reservationConfirmPrompt,
  formatVisitAt,
  DISPATCH_LABELS,
} from './trycle-pkg1-flex.js';
import { REGIONS, findRegionByValue } from '../data/pkg1-regions.js';
import { makeLineItem, type QuoteLineItem } from './quote.js';
import type { ReservationSlot } from './trycle-visit-slots.js';

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

// ── reservation slot list (経路 D-2・Option A 日時候補 縦リスト) ────────────────

function slot(p: Partial<ReservationSlot>): ReservationSlot {
  return {
    storeId: 's1',
    storeAbbr: 'Y',
    storeName: '矢野口本店',
    date: '2026-06-22',
    dateLabel: '06/22 (土)',
    timeLabel: '10:00',
    datetime: '2026-06-22t10:00',
    ...p,
  };
}

describe('reservationSlotMessages (経路 D-2・Option A 日時候補 縦リスト)', () => {
  it('renders one tap row per candidate with store+datetime in the postback', () => {
    const msgs = reservationSlotMessages([
      slot({ storeId: 's1', storeAbbr: 'Y', timeLabel: '10:00', datetime: '2026-06-22t10:00' }),
      slot({ storeId: 's2', storeAbbr: 'M', storeName: '宮ヶ瀬店', timeLabel: '10:30', datetime: '2026-06-22t10:30' }),
    ]);
    expect(msgs).toHaveLength(1);
    expectNotTemplate(msgs[0]);
    expectBubble(msgs[0]);
    const s = serialize(msgs);
    // postback は store と ISO 日時を内包する ({storeId}|{datetime})。
    expect(s).toContain('action=pkg1_reserve_slot&value=s1|2026-06-22t10:00');
    expect(s).toContain('action=pkg1_reserve_slot&value=s2|2026-06-22t10:30');
    // tap row ラベルは「{HH:MM} {店舗略称}」。
    expect(s).toContain('10:00 Y');
    expect(s).toContain('10:30 M');
  });

  it('inserts a per-date section label and keeps dates in chronological order', () => {
    const msgs = reservationSlotMessages([
      slot({ date: '2026-06-22', dateLabel: '06/22 (土)', timeLabel: '10:00', datetime: '2026-06-22t10:00' }),
      slot({ date: '2026-06-23', dateLabel: '06/23 (日)', timeLabel: '11:00', datetime: '2026-06-23t11:00' }),
    ]);
    const s = serialize(msgs);
    expect(s).toContain('📅 06/22 (土)');
    expect(s).toContain('📅 06/23 (日)');
    expect(s.indexOf('06/22')).toBeLessThan(s.indexOf('06/23'));
  });

  it('splits into a carousel when many candidates exceed the bubble byte budget', () => {
    // 14 日 × 2 店舗 × 5 slot/day = 140 候補相当。10KB を超えるので carousel 分割される。
    const slots: ReservationSlot[] = [];
    for (let day = 0; day < 14; day += 1) {
      const date = `2026-07-${String(day + 1).padStart(2, '0')}`;
      for (const [id, abbr] of [['s1', 'Y'], ['s2', 'M']] as const) {
        for (let h = 10; h < 15; h += 1) {
          const time = `${String(h).padStart(2, '0')}:00`;
          slots.push(
            slot({ storeId: id, storeAbbr: abbr, date, dateLabel: `07/${String(day + 1).padStart(2, '0')} (—)`, timeLabel: time, datetime: `${date}t${time}` }),
          );
        }
      }
    }
    expect(slots).toHaveLength(140);
    const msgs = reservationSlotMessages(slots);
    // 単一 Flex メッセージだが contents は carousel (複数 bubble)。
    expect(msgs).toHaveLength(1);
    const contents = (msgs[0] as { contents: { type: string; contents?: unknown[] } }).contents;
    expect(contents.type).toBe('carousel');
    expect((contents.contents ?? []).length).toBeGreaterThan(1);
    // 全 140 候補の postback が漏れず載る。
    const s = serialize(msgs);
    expect(s).toContain('action=pkg1_reserve_slot&value=s1|2026-07-01t10:00');
    expect(s).toContain('action=pkg1_reserve_slot&value=s2|2026-07-14t14:00');
  });

  it('fails loud (準備中) with no postback when there are no candidates', () => {
    const msgs = reservationSlotMessages([]);
    expect(msgs).toHaveLength(1);
    expectNotTemplate(msgs[0]);
    expectBubble(msgs[0]);
    const s = serialize(msgs);
    expect(s).not.toContain('pkg1_reserve_slot');
    expect(s).toContain('見つかりませんでした');
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

// ── Bubble 10KB 不変条件 (920ecff の port・実シードで再現) ─────────────────────
//
// LINE の 1 bubble = 10240 byte 上限を超えると reply が 400 で silent reject され、
// safeReply が握り潰す → 利用者には「無反応」。実シード (REGIONS) の全分岐で、各
// bubble (carousel の場合は各 column) が上限未満であることを assert する。合成データ
// では bubble が小さく問題を見逃すため、必ず実シード全件で測る ([[feedback-verify-with-real-operation]])。

const LINE_BUBBLE_LIMIT = 10240;

/** FlexMessage 1 件の最大 bubble byte size (carousel なら最大 column)。 */
function maxBubbleBytes(msg: unknown): number {
  const m = msg as { contents?: { type?: string; contents?: unknown[] } };
  const c = m.contents;
  if (c?.type === 'carousel' && Array.isArray(c.contents)) {
    return Math.max(...c.contents.map((b) => new TextEncoder().encode(JSON.stringify(b)).length));
  }
  return new TextEncoder().encode(JSON.stringify(c)).length;
}

describe('Bubble 10KB 不変条件 (実シード REGIONS 全分岐)', () => {
  it('region 一覧 bubble は 10KB 未満', () => {
    for (const msg of regionMessages(REGIONS)) {
      expect(maxBubbleBytes(msg)).toBeLessThan(LINE_BUBBLE_LIMIT);
    }
  });

  it('全 region の symptom 一覧 bubble が 10KB 未満 (carousel 分割込み)', () => {
    for (const region of REGIONS) {
      if (!region.symptoms) continue;
      for (const msg of symptomMessages(region)) {
        const bytes = maxBubbleBytes(msg);
        expect(bytes, `symptom[${region.value}]`).toBeLessThan(LINE_BUBBLE_LIMIT);
      }
    }
  });

  it('全 symptom の variant 一覧 / qty bubble が 10KB 未満', () => {
    for (const region of REGIONS) {
      if (!region.symptoms) continue;
      for (const symptom of region.symptoms) {
        if (symptom.variants && symptom.variants.length > 0) {
          for (const msg of variantMessages(symptom)) {
            expect(maxBubbleBytes(msg), `variant[${region.value}/${symptom.label}]`).toBeLessThan(
              LINE_BUBBLE_LIMIT,
            );
          }
        }
        if (symptom.qty) {
          expect(maxBubbleBytes(qtyPrompt(symptom)), `qty[${region.value}/${symptom.label}]`).toBeLessThan(
            LINE_BUBBLE_LIMIT,
          );
        }
      }
    }
  });

  it('confirm bubble (全 region から 1 件ずつの大きめカート) が 10KB 未満', () => {
    const bigCart = REGIONS.flatMap((r) =>
      (r.symptoms ?? []).slice(0, 1).map((s) =>
        makeLineItem({ name: `${r.label} ${s.label}`, unitPrice: 5000, qty: 2 }),
      ),
    );
    for (const msg of confirmMessages(bigCart)) {
      expect(maxBubbleBytes(msg)).toBeLessThan(LINE_BUBBLE_LIMIT);
    }
  });

  it('その他関係 (15 件) は単一 bubble を超え carousel に分割される', () => {
    const otherParts = REGIONS.find((r) => r.value === 'other-parts')!;
    const msgs = symptomMessages(otherParts);
    const serialized = JSON.stringify(msgs);
    expect(serialized).toContain('carousel');
    // 全 column が上限未満。
    for (const msg of msgs) {
      expect(maxBubbleBytes(msg)).toBeLessThan(LINE_BUBBLE_LIMIT);
    }
  });

  it('少数件の region 一覧は従来どおり単一 bubble (見た目不変)', () => {
    // 9 部位 = 単一 bubble に収まる (carousel に退化しない)。
    const msgs = regionMessages(REGIONS);
    expect(msgs).toHaveLength(1);
    expect(JSON.stringify(msgs)).not.toContain('carousel');
  });
});
