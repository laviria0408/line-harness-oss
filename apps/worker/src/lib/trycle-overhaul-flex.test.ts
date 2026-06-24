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
  buildFeatureUniverse,
  summarizeDescription,
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
  it('picker shows a one-line description (一言) per menu', () => {
    const s = JSON.stringify(
      overhaulMenuPicker([
        menu({ detailedDescription: 'ホイール振れ取り、各種ワイヤー交換、シフト調整が含まれるシンプルなプランです。' }),
      ]),
    );
    // 最初の句点までを一言として表示する。
    expect(s).toContain('ホイール振れ取り、各種ワイヤー交換、シフト調整が含まれるシンプルなプランです。');
  });
  it('picker omits the 一言 row when detailedDescription is null', () => {
    const s = JSON.stringify(overhaulMenuPicker([menu({ detailedDescription: null })]));
    // 名前と料金は出るが、説明用の muted テキストは無い。
    expect(s).toContain('オーバーホール プレミアム');
    expect(s).toContain('¥80,000');
  });
});

describe('summarizeDescription', () => {
  it('returns null for null / empty', () => {
    expect(summarizeDescription(null)).toBeNull();
    expect(summarizeDescription('   ')).toBeNull();
  });
  it('takes the first sentence (句点まで)', () => {
    expect(summarizeDescription('一文目です。二文目です。')).toBe('一文目です。');
  });
  it('truncates very long single sentences with …', () => {
    const long = 'あ'.repeat(80);
    const out = summarizeDescription(long)!;
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('overhaulMatrixMessages / buildMatrixAltText', () => {
  // 2 メニュー: premium は全機能含む / light は一部のみ → light に × が出る。
  const matrix: OverhaulMenuMatrix[] = [
    {
      menu: menu({ name: 'プレミアム' }),
      includedFeatures: ['分解・洗浄・組み立て', '各部トルクチェック', 'ホイール振れ取り'],
      optionalFeatures: [{ featureName: '油圧ホース交換', priceLabel: '¥12,000' }],
    },
    {
      menu: menu({ laborId: 'lm-2', code: 'oh-light', name: 'ライト' }),
      includedFeatures: ['各部トルクチェック'],
      optionalFeatures: [],
    },
  ];

  it('buildFeatureUniverse unions included features in order without dups', () => {
    expect(buildFeatureUniverse(matrix)).toEqual([
      '分解・洗浄・組み立て',
      '各部トルクチェック',
      'ホイール振れ取り',
    ]);
  });

  it('builds a per-menu card carousel with both ◯ and × marks', () => {
    const msgs = overhaulMatrixMessages(matrix);
    const s = JSON.stringify(msgs);
    expect(msgs.length).toBe(1);
    expect((msgs[0].contents as { contents: unknown[] }).contents.length).toBe(2);
    // 全機能名が (どのカードでも) 表示される。
    expect(s).toContain('分解・洗浄・組み立て');
    expect(s).toContain('各部トルクチェック');
    expect(s).toContain('ホイール振れ取り');
    // ◯ も × も両方使われる (light は premium にある機能が無い)。
    expect(s).toContain('◯');
    expect(s).toContain('×');
    // オプションも残る。
    expect(s).toContain('油圧ホース交換');
    expect(s).toContain('¥12,000');
    // altText にメニュー名が出る。
    expect(msgs[0].altText).toContain('プレミアム');
  });

  it('light card marks premium-only features as × (含まれない)', () => {
    const msgs = overhaulMatrixMessages(matrix);
    // carousel の 2 枚目 = ライト。「含まれない ×」が premium-only 機能に付く。
    const lightCard = (msgs[0].contents as { contents: { body: { contents: object[] } }[] }).contents[1];
    const lines = JSON.stringify(lightCard.body.contents);
    // ライトは「各部トルクチェック」を ◯、「分解・洗浄・組み立て」「ホイール振れ取り」を × にする。
    expect(lines).toContain('×');
    expect(lines).toContain('◯');
  });

  it('altText summarizes ◯/× counts and stays within LINE limit', () => {
    const alt = buildMatrixAltText(matrix);
    // premium = 3 含まれる / 0 含まれない、light = 1 / 2。
    expect(alt).toContain('含まれる ◯3 / 含まれない ×0');
    expect(alt).toContain('含まれる ◯1 / 含まれない ×2');
    expect(alt.length).toBeLessThanOrEqual(400);
  });
});

describe('matrix carousel byte budget (LINE 1 bubble ≤ 10KB)', () => {
  // 本番 snapshot 相当 (4 メニュー・22 機能全集合・premium=22◯+6opt / light-maintenance=7◯)。
  // 最大カード (premium) が 10KB を超えないことを保証する (Flex silent reject 防止)。
  const FEATURES = [
    '分解・洗浄・組み立て', '最小単位での分解洗浄', '各部トルクチェック', '各部のガタの点検', '各部注油',
    'フレームクリーニング', '簡易ガラスコーティング', 'ヘッドパーツ交換（グリスアップ）', 'ヘッド調整',
    '前後ブレーキ調整', 'ブレーキシュー・パッド交換', 'ワイヤー・ホース全交換', '前後シフト調整',
    'ハンガー修正', 'ワイヤー全交換', 'BB交換（グリスアップ）', 'チェーン交換', 'タイヤ、チューブ交換',
    'ホイールセンター出し', 'ホイール振れ取り', 'ハブグリスアップ', 'ペダルオーバーホール',
  ];
  const OPTIONS = [
    { featureName: 'ガラスコーティング', priceLabel: '¥15,000' },
    { featureName: 'マクハル', priceLabel: '¥11,000' },
    { featureName: 'ホイールバランス取り', priceLabel: '¥8,800' },
    { featureName: '別ホイール　ローター位置調整', priceLabel: '¥3,960' },
    { featureName: 'カーボン補修', priceLabel: '¥0' },
    { featureName: '全塗装', priceLabel: '¥0' },
  ];
  const snapshot: OverhaulMenuMatrix[] = [
    { menu: menu({ laborId: 'lm-p', code: 'oh-premium', name: 'オーバーホール プレミアム' }), includedFeatures: FEATURES, optionalFeatures: OPTIONS },
    { menu: menu({ laborId: 'lm-s', code: 'oh-standard', name: 'オーバーホール スタンダード' }), includedFeatures: FEATURES.slice(0, 19), optionalFeatures: OPTIONS },
    { menu: menu({ laborId: 'lm-l', code: 'oh-light', name: 'オーバーホール ライト' }), includedFeatures: FEATURES.slice(2, 14), optionalFeatures: [] },
    { menu: menu({ laborId: 'lm-lm', code: 'light-maintenance', name: 'ライトメンテナンス' }), includedFeatures: FEATURES.slice(2, 9), optionalFeatures: [] },
  ];

  function byteLength(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  }

  it('every matrix bubble stays under the LINE 10KB single-bubble limit', () => {
    const msgs = overhaulMatrixMessages(snapshot);
    const bubbles = (msgs[0].contents as { contents: unknown[] }).contents;
    expect(bubbles.length).toBe(4);
    for (const bubble of bubbles) {
      expect(byteLength(bubble)).toBeLessThan(10240);
    }
  });
});
