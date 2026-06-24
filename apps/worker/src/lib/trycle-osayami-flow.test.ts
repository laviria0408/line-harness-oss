/**
 * お悩みフロー (A1・v1.6) のループ判定 純関数テスト。
 * present / staff_no_match / staff_max と残回数の計算を検証する。
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateOsayamiTurn,
  canAskAgain,
  candidateCodes,
  pickCandidateCode,
  matchNote,
} from './trycle-osayami-flow.js';
import { OSAYAMI_MAX_LOOPS } from './trycle-session.js';
import type { LaborMatch } from './trycle-labor-search.js';
import type { LaborRow } from './trycle-pkg1-repo.js';

function labor(code: string, over: Partial<LaborRow> = {}): LaborRow {
  return {
    id: `id-${code}`,
    code,
    category: 'cat',
    name: `作業:${code}`,
    price: 3000,
    price_max: null,
    price_open_ended: false,
    notes: null,
    tags: [],
    description: null,
    ...over,
  };
}

function match(code: string, score: number): LaborMatch {
  return { labor: labor(code), score };
}

describe('evaluateOsayamiTurn', () => {
  it('present: 1 回目の入力で候補ありなら提示・残 MAX-1', () => {
    const r = evaluateOsayamiTurn(0, [match('a', 0.5), match('b', 0.4)]);
    expect(r.kind).toBe('present');
    expect(r.matches.length).toBe(2);
    expect(r.nextLoopCount).toBe(1);
    expect(r.remainingLoops).toBe(OSAYAMI_MAX_LOOPS - 1);
  });

  it('present: 候補は最大 3 件に絞る', () => {
    const many = [match('a', 0.5), match('b', 0.4), match('c', 0.3), match('d', 0.2)];
    const r = evaluateOsayamiTurn(0, many);
    expect(r.matches.length).toBe(3);
  });

  it('staff_no_match: 0 件なら staff へ (回数は消費する)', () => {
    const r = evaluateOsayamiTurn(1, []);
    expect(r.kind).toBe('staff_no_match');
    expect(r.nextLoopCount).toBe(2);
  });

  it('staff_max: MAX 回使い切ったあとのもう 1 回は自動回答打ち切り', () => {
    const r = evaluateOsayamiTurn(OSAYAMI_MAX_LOOPS, [match('a', 0.9)]);
    expect(r.kind).toBe('staff_max');
    expect(r.matches.length).toBe(0);
    expect(r.remainingLoops).toBe(0);
  });

  it('最後の 1 回 (used === MAX) は present で残 0', () => {
    const r = evaluateOsayamiTurn(OSAYAMI_MAX_LOOPS - 1, [match('a', 0.9)]);
    expect(r.kind).toBe('present');
    expect(r.remainingLoops).toBe(0);
  });
});

describe('canAskAgain', () => {
  it('true while below max', () => {
    expect(canAskAgain(0)).toBe(true);
    expect(canAskAgain(OSAYAMI_MAX_LOOPS - 1)).toBe(true);
  });
  it('false at/over max', () => {
    expect(canAskAgain(OSAYAMI_MAX_LOOPS)).toBe(false);
    expect(canAskAgain(OSAYAMI_MAX_LOOPS + 1)).toBe(false);
  });
});

describe('candidate code helpers', () => {
  it('candidateCodes maps matches to labor codes', () => {
    expect(candidateCodes([match('a', 0.5), match('b', 0.4)])).toEqual(['a', 'b']);
  });
  it('pickCandidateCode resolves by index, null for out-of-range', () => {
    const codes = ['a', 'b', 'c'];
    expect(pickCandidateCode(codes, 1)).toBe('b');
    expect(pickCandidateCode(codes, -1)).toBeNull();
    expect(pickCandidateCode(codes, 3)).toBeNull();
    expect(pickCandidateCode(undefined, 0)).toBeNull();
  });
});

describe('matchNote', () => {
  it('prefers description over notes', () => {
    expect(matchNote(labor('x', { description: 'desc', notes: 'note' }))).toBe('desc');
    expect(matchNote(labor('x', { description: null, notes: 'note' }))).toBe('note');
  });
  it('truncates long text', () => {
    const long = 'あ'.repeat(100);
    const note = matchNote(labor('x', { description: long }), 20);
    expect(note!.length).toBe(20);
    expect(note!.endsWith('…')).toBe(true);
  });
  it('null when no description/notes', () => {
    expect(matchNote(labor('x'))).toBeNull();
  });
});
