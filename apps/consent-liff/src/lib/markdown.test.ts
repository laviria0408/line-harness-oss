import { describe, expect, test } from 'vitest';
import { parseMarkdown } from './markdown.js';

describe('parseMarkdown', () => {
  test('parses headings of levels 1-3', () => {
    const blocks = parseMarkdown('# H1\n## H2\n### H3');
    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: 'H1' },
      { type: 'heading', level: 2, text: 'H2' },
      { type: 'heading', level: 3, text: 'H3' },
    ]);
  });

  test('joins consecutive non-blank lines into one paragraph', () => {
    const blocks = parseMarkdown('行1\n行2\n\n別の段落');
    expect(blocks).toEqual([
      { type: 'paragraph', text: '行1 行2' },
      { type: 'paragraph', text: '別の段落' },
    ]);
  });

  test('groups list items into a single list block', () => {
    const blocks = parseMarkdown('- 項目1\n- 項目2\n* 項目3');
    expect(blocks).toEqual([{ type: 'list', items: ['項目1', '項目2', '項目3'] }]);
  });

  test('separates a paragraph from a following list', () => {
    const blocks = parseMarkdown('説明文\n- a\n- b');
    expect(blocks).toEqual([
      { type: 'paragraph', text: '説明文' },
      { type: 'list', items: ['a', 'b'] },
    ]);
  });

  test('returns empty array for empty input', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('\n\n')).toEqual([]);
  });
});
