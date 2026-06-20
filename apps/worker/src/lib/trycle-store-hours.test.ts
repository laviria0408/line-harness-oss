import { describe, it, expect } from 'vitest';
import { parseJstDatetime, validateVisitAt } from './trycle-store-hours.js';
import type { StoreRow } from './trycle-repo.js';

describe('parseJstDatetime', () => {
  it('parses LINE datetimepicker format', () => {
    const d = parseJstDatetime('2026-06-25t14:30');
    expect(d).not.toBeNull();
    expect(d?.getUTCFullYear()).toBe(2026);
    expect(d?.getUTCMonth()).toBe(5); // 0-indexed → June
    expect(d?.getUTCDate()).toBe(25);
    expect(d?.getUTCHours()).toBe(14);
    expect(d?.getUTCMinutes()).toBe(30);
  });

  it('rejects malformed input', () => {
    expect(parseJstDatetime('2026/06/25 14:30')).toBeNull();
    expect(parseJstDatetime('xxx')).toBeNull();
    expect(parseJstDatetime('')).toBeNull();
  });
});

const yanoguchi: StoreRow = {
  id: 'store-yano',
  name: '矢野口本店',
  code: 'Y',
  business_hours: {
    mon: ['11:00', '19:00'],
    tue: ['11:00', '19:00'],
    wed: ['11:00', '19:00'],
    thu: ['11:00', '19:00'],
    fri: ['11:00', '19:00'],
    sat: ['11:00', '19:00'],
    sun: ['11:00', '19:00'],
  },
  reservation_slot_minutes: 30,
  is_active: true,
};

const miyagase: StoreRow = {
  id: 'store-mi',
  name: '宮ヶ瀬店',
  code: 'M',
  business_hours: {
    mon: [],
    tue: [],
    wed: ['11:00', '17:00'],
    thu: ['11:00', '17:00'],
    fri: ['11:00', '17:00'],
    sat: ['11:00', '17:00'],
    sun: ['11:00', '17:00'],
  },
  reservation_slot_minutes: 30,
  is_active: true,
};

describe('validateVisitAt', () => {
  it('accepts a within-hours, on-slot time', () => {
    // 2026-06-25 (Thu) 14:30 → 矢野口 11:00-19:00 / slot=30 ✓
    const d = parseJstDatetime('2026-06-25t14:30')!;
    expect(validateVisitAt(yanoguchi, d)).toEqual({ ok: true });
  });

  it('rejects closed weekday', () => {
    // 2026-06-22 (Mon) → 宮ヶ瀬 月曜定休
    const d = parseJstDatetime('2026-06-22t14:30')!;
    const v = validateVisitAt(miyagase, d);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/月曜日は定休日/);
  });

  it('rejects out-of-hours', () => {
    // 2026-06-25 (Thu) 20:00 → 矢野口 19:00 close
    const d = parseJstDatetime('2026-06-25t20:00')!;
    const v = validateVisitAt(yanoguchi, d);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/営業時間/);
  });

  it('rejects off-grid (not aligned to 30 min)', () => {
    // 2026-06-25 (Thu) 14:15 → not on 30-min slot
    const d = parseJstDatetime('2026-06-25t14:15')!;
    const v = validateVisitAt(yanoguchi, d);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/30分刻み/);
  });

  it('rejects close-time edge (exclusive)', () => {
    // 19:00 が close → 19:00 自体は不可 (>= closeMin で reject)
    const d = parseJstDatetime('2026-06-25t19:00')!;
    expect(validateVisitAt(yanoguchi, d).ok).toBe(false);
  });
});
