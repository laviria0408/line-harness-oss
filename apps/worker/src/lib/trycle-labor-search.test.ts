/**
 * お悩み trigram マッチング (A1・v1.6) の純関数テスト。
 * similarity / trigrams / rankLabor を DB 不要で検証する。
 */
import { describe, it, expect } from 'vitest';
import {
  trigrams,
  similarity,
  scoreLabor,
  rankLabor,
  OSAYAMI_MATCH_THRESHOLD,
} from './trycle-labor-search.js';
import type { LaborRow } from './trycle-pkg1-repo.js';

function labor(partial: Partial<LaborRow> & { code: string; name: string }): LaborRow {
  return {
    id: `id-${partial.code}`,
    code: partial.code,
    category: partial.category ?? 'cat',
    name: partial.name,
    price: partial.price ?? 3000,
    price_max: partial.price_max ?? null,
    price_open_ended: partial.price_open_ended ?? false,
    notes: partial.notes ?? null,
    tags: partial.tags ?? [],
    description: partial.description ?? null,
  };
}

describe('trigrams', () => {
  it('returns empty set for empty / whitespace input', () => {
    expect(trigrams('').size).toBe(0);
    expect(trigrams('   ').size).toBe(0);
  });
  it('pads words like pg_trgm (前 2 / 後 1 空白)', () => {
    // "ab" → "  ab " → 3-grams: "  a", " ab", "ab "
    const g = trigrams('ab');
    expect(g.has('  a')).toBe(true);
    expect(g.has(' ab')).toBe(true);
    expect(g.has('ab ')).toBe(true);
  });
  it('lowercases ASCII', () => {
    expect(trigrams('AB')).toEqual(trigrams('ab'));
  });
});

describe('similarity', () => {
  it('is 0 when either side is empty', () => {
    expect(similarity('', 'ブレーキ')).toBe(0);
    expect(similarity('ブレーキ', '')).toBe(0);
  });
  it('is 1 for identical strings', () => {
    expect(similarity('ブレーキ調整', 'ブレーキ調整')).toBeCloseTo(1, 5);
  });
  it('is higher for closer strings', () => {
    const close = similarity('ブレーキ調整', 'ブレーキ交換');
    const far = similarity('ブレーキ調整', 'タイヤ交換');
    expect(close).toBeGreaterThan(far);
  });
  it('is symmetric', () => {
    expect(similarity('チェーン交換', 'チェーン')).toBeCloseTo(
      similarity('チェーン', 'チェーン交換'),
      5,
    );
  });
});

describe('scoreLabor', () => {
  it('takes the max over name / description / tags', () => {
    const row = labor({
      code: 'brake-adjust',
      name: 'ブレーキ調整',
      description: '効きが悪いときの調整',
      tags: ['ブレーキ', '効かない'],
    });
    // クエリが tags にだけ近いケースでも score が立つ。
    const byTag = scoreLabor('効かない', row);
    expect(byTag).toBeGreaterThan(0);
  });
  it('returns 0 when nothing matches', () => {
    const row = labor({ code: 'x', name: 'タイヤ交換' });
    expect(scoreLabor('完全に無関係なクエリ___zzz', row)).toBeLessThanOrEqual(OSAYAMI_MATCH_THRESHOLD);
  });
});

describe('rankLabor', () => {
  const rows: LaborRow[] = [
    labor({ code: 'brake-adjust', name: 'ブレーキ調整', tags: ['ブレーキ', '効かない'] }),
    labor({ code: 'brake-pad', name: 'ブレーキパッド交換', tags: ['ブレーキ', 'パッド'] }),
    labor({ code: 'tire-swap', name: 'タイヤ交換', tags: ['タイヤ'] }),
    labor({ code: 'chain', name: 'チェーン交換', tags: ['チェーン'] }),
  ];

  it('returns top-N by score descending', () => {
    const out = rankLabor('ブレーキ', rows, 0.05, 3);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(3);
    // ブレーキ系が先頭に来る。
    expect(out[0].labor.code.startsWith('brake')).toBe(true);
    // score 降順。
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
    }
  });

  it('filters out below-threshold rows', () => {
    const out = rankLabor('ブレーキ', rows, 0.99, 3);
    expect(out.length).toBe(0); // 閾値 0.99 ではどれも届かない。
  });

  it('returns empty for empty/whitespace query path (via rank with empty)', () => {
    expect(rankLabor('', rows).length).toBe(0);
  });

  it('caps at topN even when more match', () => {
    const out = rankLabor('交換', rows, 0.01, 2);
    expect(out.length).toBeLessThanOrEqual(2);
  });
});
