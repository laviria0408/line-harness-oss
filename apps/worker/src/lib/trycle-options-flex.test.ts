/**
 * trycle-options-flex — labor_options 自動聞きの単一 option 問い Flex の単体テスト。
 */
import { describe, it, expect } from 'vitest';
import { buildOptionPromptBubble, formatOptionPrice } from './trycle-options-flex.js';
import type { LaborOptionRow } from './trycle-pkg1-repo.js';

function option(overrides: Partial<LaborOptionRow> = {}): LaborOptionRow {
  return {
    id: 'opt-1',
    laborId: 'la-oh',
    code: 'glass-coat',
    name: 'ガラスコーティング',
    price: 15000,
    isDefault: false,
    notes: null,
    sortOrder: 10,
    ...overrides,
  };
}

describe('formatOptionPrice', () => {
  it('renders +¥ for a priced option', () => {
    // Arrange / Act / Assert
    expect(formatOptionPrice({ price: 15000 })).toBe('+¥15,000');
  });

  it('renders 要相談 for a zero-price option (not free)', () => {
    expect(formatOptionPrice({ price: 0 })).toBe('要相談');
  });
});

describe('buildOptionPromptBubble', () => {
  it('asks add/skip with the option id embedded in postback data', () => {
    const bubble = buildOptionPromptBubble(option({ id: 'opt-x' }), 3);
    const json = JSON.stringify(bubble);
    expect(json).toContain('ガラスコーティング');
    expect(json).toContain('+¥15,000');
    expect(json).toContain('action=pkg1_option&value=add:opt-x');
    expect(json).toContain('action=pkg1_option&value=skip:opt-x');
  });

  it('shows the remaining count when more than one option is left', () => {
    const bubble = buildOptionPromptBubble(option(), 3);
    expect(JSON.stringify(bubble)).toContain('残り3件');
  });

  it('omits the remaining count for the last option', () => {
    const bubble = buildOptionPromptBubble(option(), 1);
    const json = JSON.stringify(bubble);
    expect(json).not.toContain('残り');
  });

  it('surfaces the option notes (例: お見積もり要相談) for a 要相談 option', () => {
    const bubble = buildOptionPromptBubble(
      option({ price: 0, name: '全塗装', notes: 'お見積もり要相談' }),
      1,
    );
    const json = JSON.stringify(bubble);
    expect(json).toContain('要相談');
    expect(json).toContain('お見積もり要相談');
  });

  it('stays well under the LINE 10KB single-bubble limit', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(buildOptionPromptBubble(option(), 6))).length;
    expect(bytes).toBeLessThan(10240);
  });
});
