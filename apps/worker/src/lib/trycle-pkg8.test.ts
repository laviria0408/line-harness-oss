import { describe, expect, test } from 'vitest';
import { isPkg8Postback, buildAnswerBubble, buildLinkButtons } from './trycle-pkg8.js';
import type { FaqRow, FaqLinkRow } from './trycle-faq-repo.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeFaq(partial: Partial<FaqRow> = {}): FaqRow {
  return {
    id: 'business-hours',
    tenant_id: 't1',
    question: '営業時間は？',
    answer: '10時〜19時です。',
    category: null,
    tags: null,
    sort_order: 0,
    archived: false,
    view_count: 0,
    helpful_count: 0,
    unhelpful_count: 0,
    follow_up: null,
    links: [],
    ...partial,
  };
}

function makeLink(partial: Partial<FaqLinkRow> & { id: string }): FaqLinkRow {
  return {
    label: 'リンク',
    action_type: 'uri',
    url: 'https://example.com',
    postback_data: null,
    sort_order: 0,
    ...partial,
  };
}

/** body の text を平坦に集める (separator は除外)。 */
function bodyTexts(bubble: ReturnType<typeof buildAnswerBubble>): string[] {
  const body = (bubble.contents as any).body;
  return body.contents
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text);
}

/** footer の button action を集める。 */
function footerButtonActions(bubble: ReturnType<typeof buildAnswerBubble>): any[] {
  const footer = (bubble.contents as any).footer;
  const actions: any[] = [];
  for (const item of footer.contents) {
    if (item.type === 'button') actions.push(item.action);
    if (item.type === 'box' && Array.isArray(item.contents)) {
      for (const c of item.contents) if (c.type === 'button') actions.push(c.action);
    }
  }
  return actions;
}

describe('isPkg8Postback', () => {
  test('matches faq_ prefix postbacks', () => {
    expect(isPkg8Postback('faq_start')).toBe(true);
    expect(isPkg8Postback('faq_cat_整備')).toBe(true);
    expect(isPkg8Postback('faq_q_business-hours')).toBe(true);
    expect(isPkg8Postback('faq_h_xxx')).toBe(true);
    expect(isPkg8Postback('faq_u_xxx')).toBe(true);
  });

  test('matches legacy pkg8_ prefix for backward compatibility', () => {
    expect(isPkg8Postback('pkg8_start')).toBe(true);
  });

  test('rejects other prefixes', () => {
    expect(isPkg8Postback('pkg1_start')).toBe(false);
    expect(isPkg8Postback('consent_open')).toBe(false);
    expect(isPkg8Postback('reservation_create')).toBe(false);
    expect(isPkg8Postback('random_postback')).toBe(false);
    expect(isPkg8Postback('')).toBe(false);
  });

  test('handles edge cases', () => {
    expect(isPkg8Postback('faq')).toBe(false); // prefix incomplete (no trailing _)
    expect(isPkg8Postback('pkg8')).toBe(false);
    expect(isPkg8Postback('_faq_start')).toBe(false); // leading underscore
  });
});

describe('buildLinkButtons (REQ-PKG8-008)', () => {
  test('uri リンクは uri action button になる', () => {
    const buttons = buildLinkButtons([
      makeLink({ id: 'l1', label: '公式サイト', action_type: 'uri', url: 'https://example.com' }),
    ]) as any[];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].action).toEqual({ type: 'uri', label: '公式サイト', uri: 'https://example.com' });
  });

  test('postback リンクは postback action button になる', () => {
    const buttons = buildLinkButtons([
      makeLink({ id: 'l1', label: '見積もり', action_type: 'postback', url: null, postback_data: 'pkg1_start' }),
    ]) as any[];
    expect(buttons[0].action).toEqual({ type: 'postback', label: '見積もり', data: 'pkg1_start' });
  });

  test('不整合な行 (uri なのに url なし) は安全側で除外', () => {
    const buttons = buildLinkButtons([
      makeLink({ id: 'l1', label: 'こわれ', action_type: 'uri', url: null }),
      makeLink({ id: 'l2', label: 'ok', action_type: 'uri', url: 'https://ok.example' }),
    ]) as any[];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].action.label).toBe('ok');
  });

  test('最大 3 button まで (LINE footer の見切れ防止)', () => {
    const links = Array.from({ length: 5 }, (_, i) =>
      makeLink({ id: `l${i}`, label: `link${i}`, url: `https://example.com/${i}` }),
    );
    const buttons = buildLinkButtons(links);
    expect(buttons).toHaveLength(3);
  });

  test('リンク無しは空配列', () => {
    expect(buildLinkButtons([])).toEqual([]);
  });
});

describe('buildAnswerBubble follow_up + links (REQ-PKG8-006 / 008)', () => {
  test('follow_up が無いときは answer のみ', () => {
    const bubble = buildAnswerBubble(makeFaq({ answer: '10時〜19時です。' }));
    expect(bodyTexts(bubble)).toEqual(['10時〜19時です。']);
  });

  test('follow_up があるとき answer の後ろに追記される', () => {
    const bubble = buildAnswerBubble(
      makeFaq({ answer: '10時〜19時です。', follow_up: '詳しくはスタッフへ' }),
    );
    expect(bodyTexts(bubble)).toEqual(['10時〜19時です。', '詳しくはスタッフへ']);
  });

  test('空白だけの follow_up は追記しない', () => {
    const bubble = buildAnswerBubble(makeFaq({ follow_up: '   ' }));
    expect(bodyTexts(bubble)).toEqual(['10時〜19時です。']);
  });

  test('links が footer のリンクボタンと既存ボタンの両方を含む', () => {
    const bubble = buildAnswerBubble(
      makeFaq({
        id: 'fid',
        links: [
          makeLink({ id: 'l1', label: '公式サイト', action_type: 'uri', url: 'https://example.com' }),
          makeLink({ id: 'l2', label: '見積もり', action_type: 'postback', url: null, postback_data: 'pkg1_start' }),
        ],
      }),
    );
    const actions = footerButtonActions(bubble);
    // リンクボタン (uri + postback) が既存 [解決した][困った][戻る] と共存する
    expect(actions).toContainEqual({ type: 'uri', label: '公式サイト', uri: 'https://example.com' });
    expect(actions).toContainEqual({ type: 'postback', label: '見積もり', data: 'pkg1_start' });
    expect(actions).toContainEqual({ type: 'postback', label: '解決した', data: 'faq_h_fid' });
    expect(actions).toContainEqual({ type: 'postback', label: '困った', data: 'faq_u_fid' });
    expect(actions).toContainEqual({ type: 'postback', label: '← FAQ に戻る', data: 'faq_start' });
  });

  test('links が無いときは既存ボタンのみ', () => {
    const bubble = buildAnswerBubble(makeFaq({ id: 'fid', links: [] }));
    const actions = footerButtonActions(bubble);
    expect(actions).toHaveLength(3); // 解決した / 困った / 戻る
  });
});
