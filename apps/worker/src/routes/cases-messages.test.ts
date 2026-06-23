import { describe, it, expect } from 'vitest';
import { normalizeDirection } from './cases-messages.js';

describe('normalizeDirection', () => {
  const base = {
    direction: 'outgoing' as const,
    source: null,
    delivery_type: null,
    broadcast_id: null,
    scenario_step_id: null,
  };

  it('maps incoming → user', () => {
    expect(normalizeDirection({ ...base, direction: 'incoming' })).toBe('user');
  });

  it('maps outgoing manual → staff (有人返信)', () => {
    expect(normalizeDirection({ ...base, source: 'manual' })).toBe('staff');
  });

  it('maps outgoing scenario → bot', () => {
    expect(normalizeDirection({ ...base, source: 'scenario' })).toBe('bot');
  });

  it('maps outgoing auto_reply (Pkg1/Pkg8 reply) → bot', () => {
    expect(normalizeDirection({ ...base, source: 'auto_reply' })).toBe('bot');
  });

  it('infers scenario from scenario_step_id when source is NULL → bot', () => {
    expect(normalizeDirection({ ...base, scenario_step_id: 'step-1' })).toBe('bot');
  });

  it('infers broadcast from broadcast_id when source is NULL → bot', () => {
    expect(normalizeDirection({ ...base, broadcast_id: 'bc-1' })).toBe('bot');
  });

  it('infers auto_reply from delivery_type=reply when source is NULL → bot', () => {
    expect(normalizeDirection({ ...base, delivery_type: 'reply' })).toBe('bot');
  });

  it('falls back to manual (staff) for an outgoing with no FK/source/delivery hints', () => {
    // 過去 writer が source を欠落させた素の手動送信は staff 扱い。
    expect(normalizeDirection({ ...base })).toBe('staff');
  });
});
