import { describe, it, expect } from 'vitest';
import { REGIONS, findRegionByValue } from './pkg1-regions.js';

describe('REGIONS catalog (本物 regions.ts 移植)', () => {
  it('has the 9 部位 in the expected order', () => {
    expect(REGIONS.map((r) => r.value)).toEqual([
      'overhaul-related',
      'brake',
      'shift',
      'drivetrain',
      'wheel',
      'tire',
      'cockpit-head-fork',
      'other-parts',
      'other',
    ]);
  });

  it('marks the free-text その他 region with null symptoms (→ スタッフ送り)', () => {
    expect(findRegionByValue('other')!.symptoms).toBeNull();
  });

  it('each non-other region ends with an その他 symptom (sample=null)', () => {
    for (const region of REGIONS) {
      if (region.symptoms === null) continue;
      const last = region.symptoms[region.symptoms.length - 1];
      expect(last.label).toBe('その他');
      expect(last.sample).toBeNull();
    }
  });

  it('exposes 排他 variants with distinct samples (ブレーキ調整 両側/片側)', () => {
    const brakeAdjust = findRegionByValue('brake')!.symptoms![0];
    expect(brakeAdjust.variants!.map((v) => v.sample)).toEqual([
      'brake-adjust-both',
      'brake-adjust-one',
    ]);
  });

  it('carries the 内装・油圧加算 surcharge on stem/handle variants', () => {
    const stem = findRegionByValue('cockpit-head-fork')!.symptoms!.find((s) => s.label === 'ステム交換')!;
    const hydraulic = stem.variants!.find((v) => v.label === '内装（油圧）')!;
    expect(hydraulic.surcharge?.amount).toBe(11000);
  });

  it('marks qty-bearing symptoms (パンク修理=pair / スポーク交換=count)', () => {
    const tire = findRegionByValue('tire')!;
    expect(tire.symptoms!.find((s) => s.label === 'パンク修理')!.qty).toBe('pair');
    const wheel = findRegionByValue('wheel')!;
    expect(wheel.symptoms!.find((s) => s.label === 'スポーク交換')!.qty).toBe('count');
  });
});
