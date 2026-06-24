/**
 * trycle-step.ts (Step ID 流入制御) の純関数テスト。
 *
 * appendStepToData / parseStep は round-trip と後方互換 (step 無し) を確認。
 * evaluateStep は advance / rollback / stale の境界を網羅する。
 */
import { describe, it, expect } from 'vitest';
import {
  appendStepToData,
  parseStep,
  evaluateStep,
  injectStepIntoMessages,
} from './trycle-step.js';

describe('appendStepToData', () => {
  it('query 形式の data に step を付ける', () => {
    expect(appendStepToData('action=pkg1_region&value=brake', 'awaiting_region')).toBe(
      'action=pkg1_region&value=brake&step=awaiting_region',
    );
  });

  it('素のトークン data にも step を付けられる', () => {
    // URLSearchParams は素のトークンを key として扱う (= "pkg1_start=")
    const out = appendStepToData('pkg1_start', 'awaiting_dispatch');
    expect(parseStep(out)).toBe('awaiting_dispatch');
    expect(out).toContain('pkg1_start');
  });

  it('既に step がある data は付け直す (重複しない)', () => {
    const once = appendStepToData('action=pkg1_qty&value=2', 'awaiting_qty');
    const twice = appendStepToData(once, 'awaiting_qty');
    expect(twice).toBe(once);
    expect((twice.match(/step=/g) ?? []).length).toBe(1);
  });

  it('step が空文字なら data をそのまま返す', () => {
    expect(appendStepToData('action=pkg1_region&value=brake', '')).toBe(
      'action=pkg1_region&value=brake',
    );
  });
});

describe('parseStep', () => {
  it('埋め込んだ step を取り出す', () => {
    expect(parseStep('action=pkg1_region&value=brake&step=awaiting_region')).toBe(
      'awaiting_region',
    );
  });

  it('step が無い (古い Flex) なら null', () => {
    expect(parseStep('action=pkg1_region&value=brake')).toBeNull();
    expect(parseStep('pkg1_start')).toBeNull();
  });

  it('step= だが値が空なら null', () => {
    expect(parseStep('action=pkg1_region&value=brake&step=')).toBeNull();
  });
});

describe('evaluateStep', () => {
  it('received === current → advance', () => {
    expect(evaluateStep('awaiting_region', 'awaiting_region', 'awaiting_dispatch')).toBe('advance');
  });

  it('received === previous → rollback', () => {
    expect(evaluateStep('awaiting_dispatch', 'awaiting_region', 'awaiting_dispatch')).toBe(
      'rollback',
    );
  });

  it('current でも previous でもない step → stale (連打後/古ボタン)', () => {
    expect(evaluateStep('awaiting_symptom', 'awaiting_cart_decision', 'awaiting_qty')).toBe('stale');
  });

  it('current が null (session 無し / 完了済み) → 何が来ても stale', () => {
    expect(evaluateStep('awaiting_region', null, null)).toBe('stale');
    expect(evaluateStep('awaiting_confirm', null, 'awaiting_time')).toBe('stale');
  });

  it('received が null (step 不明・古い Flex) → stale', () => {
    expect(evaluateStep(null, 'awaiting_region', 'awaiting_dispatch')).toBe('stale');
  });

  it('previous が null なら rollback は起きない', () => {
    expect(evaluateStep('awaiting_dispatch', 'awaiting_region', null)).toBe('stale');
  });
});

describe('injectStepIntoMessages', () => {
  it('ネストした Flex の全 postback data に step を注入する (carousel/footer 含む)', () => {
    const flex = {
      type: 'flex',
      altText: 'x',
      contents: {
        type: 'carousel',
        contents: [
          {
            type: 'bubble',
            body: {
              type: 'box',
              contents: [
                { type: 'box', action: { type: 'postback', data: 'action=pkg1_region&value=brake' } },
              ],
            },
            footer: {
              type: 'box',
              contents: [
                { type: 'button', action: { type: 'postback', data: 'faq_start' } },
              ],
            },
          },
        ],
      },
    };
    const out = injectStepIntoMessages([flex], 'awaiting_region');
    const s = JSON.stringify(out);
    expect(s).toContain('action=pkg1_region&value=brake&step=awaiting_region');
    expect(s).toContain('faq_start&step=awaiting_region');
    // 全 postback に step が乗っている (2 個)。
    expect((s.match(/step=awaiting_region/g) ?? []).length).toBe(2);
  });

  it('uri action / text は素通し (step を付けない)', () => {
    const flex = {
      type: 'flex',
      contents: {
        type: 'box',
        contents: [
          { type: 'box', action: { type: 'uri', uri: 'https://example.com' } },
          { type: 'text', text: 'hello' },
        ],
      },
    };
    const out = injectStepIntoMessages([flex], 'awaiting_store');
    const s = JSON.stringify(out);
    expect(s).not.toContain('step=');
  });

  it('元の配列を破壊しない (immutable)', () => {
    const original = [{ type: 'box', action: { type: 'postback', data: 'x=1' } }];
    const snapshot = JSON.stringify(original);
    injectStepIntoMessages(original, 'awaiting_qty');
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('step が空なら no-op (コピーを返す)', () => {
    const msgs = [{ type: 'text', text: 'a' }];
    expect(injectStepIntoMessages(msgs, '')).toEqual(msgs);
  });
});
