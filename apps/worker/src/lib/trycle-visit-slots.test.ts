import { describe, it, expect } from 'vitest';
import { generateVisitDays, nowJst } from './trycle-visit-slots.js';
import type { StoreRow } from './trycle-repo.js';

const store: StoreRow = {
  id: 's1',
  name: '矢野口本店',
  code: 'Y',
  business_hours: {
    sun: ['11:00', '19:00'],
    mon: [],
    tue: ['11:00', '19:00'],
    wed: ['11:00', '19:00'],
    thu: ['11:00', '19:00'],
    fri: ['11:00', '19:00'],
    sat: ['11:00', '19:00'],
  },
  reservation_slot_minutes: 60,
  is_active: true,
};

// 固定の JST 基準: 2026-06-23 (火) 10:00 → 営業開始前。
function fromJst(): Date {
  return new Date(Date.UTC(2026, 5, 23, 10, 0)); // tue 10:00 JST-as-UTC
}

describe('generateVisitDays', () => {
  it('skips closed weekdays (monday)', () => {
    const days = generateVisitDays(store, fromJst(), 7);
    const labels = days.map((d) => d.label);
    // 6/29 は月曜 → 含まれない
    expect(labels.some((l) => l.includes('(月)'))).toBe(false);
    expect(days.length).toBeGreaterThan(0);
  });

  it('generates on-grid slots within business hours', () => {
    const days = generateVisitDays(store, fromJst(), 1);
    expect(days).toHaveLength(1);
    const slots = days[0]!.slots;
    expect(slots[0]!.label).toBe('11:00');
    // 60-min grid: 11,12,...,18 → last < 19:00 close
    expect(slots[slots.length - 1]!.label).toBe('18:00');
    for (const s of slots) {
      expect(s.value).toMatch(/^2026-06-23t\d{2}:00$/);
    }
  });

  it('drops past slots on the current day', () => {
    // same day 14:30 → next 60-min slot = 15:00
    const from = new Date(Date.UTC(2026, 5, 23, 14, 30));
    const days = generateVisitDays(store, from, 1);
    expect(days[0]!.slots[0]!.label).toBe('15:00');
  });

  it('emits a value parseable as datetimepicker', () => {
    const days = generateVisitDays(store, fromJst(), 1);
    expect(days[0]!.slots[0]!.value).toBe('2026-06-23t11:00');
  });
});

describe('nowJst', () => {
  it('shifts UTC now by +9h into UTC fields', () => {
    const base = new Date(Date.UTC(2026, 0, 1, 0, 0)); // 00:00 UTC
    const jst = nowJst(base);
    expect(jst.getUTCHours()).toBe(9); // 09:00 JST
  });
});
