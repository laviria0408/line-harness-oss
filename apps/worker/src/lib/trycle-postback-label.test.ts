import { describe, it, expect } from 'vitest';
import { resolvePostbackLabel } from './trycle-postback-label.js';

/**
 * Phase 2 (会話履歴の完全文脈化): 顧客 postback の raw data を実ラベルへ翻訳する。
 * region/symptom/variant の index は呼び出し側が渡す region 文脈で解決する。
 */
describe('resolvePostbackLabel', () => {
  it('素の入口 postback を翻訳する', async () => {
    expect(await resolvePostbackLabel('pkg1_start')).toBe('[操作] 整備見積もりを始める');
    expect(await resolvePostbackLabel('pkg1_wage')).toBe('[操作] 工賃の確認');
  });

  it('状況ふりわけ 3 択を翻訳する', async () => {
    expect(await resolvePostbackLabel('action=pkg1_dispatch&value=identified')).toBe(
      '[操作] 「原因特定済み」を選択',
    );
    expect(await resolvePostbackLabel('action=pkg1_dispatch&value=comprehensive')).toBe(
      '[操作] 「包括メンテしたい」を選択',
    );
  });

  it('region value を実部位ラベルへ翻訳する', async () => {
    expect(await resolvePostbackLabel('action=pkg1_region&value=tire')).toBe(
      '[操作] 「タイヤ関係」を選択',
    );
    expect(await resolvePostbackLabel('action=pkg1_region&value=brake')).toBe(
      '[操作] 「ブレーキ関係」を選択',
    );
  });

  it('symptom index を region 文脈で実作業ラベルへ翻訳する', async () => {
    // tire region の symptom #5 = シーラント注入。
    const result = await resolvePostbackLabel('action=pkg1_symptom&value=5', {
      regionValue: 'tire',
    });
    expect(result).toBe('[操作] 「シーラント注入」を選択');
  });

  it('symptom #0 (パンク修理) も翻訳する', async () => {
    const result = await resolvePostbackLabel('action=pkg1_symptom&value=0', {
      regionValue: 'tire',
    });
    expect(result).toBe('[操作] 「パンク修理」を選択');
  });

  it('region 文脈が無ければ symptom index は翻訳しない (null = raw 保存)', async () => {
    expect(await resolvePostbackLabel('action=pkg1_symptom&value=5')).toBeNull();
  });

  it('variant index を region+symptom 文脈で実種類ラベルへ翻訳する', async () => {
    // brake region の symptom #0 (ブレーキ調整) の variant #1 = 片側のみ。
    const result = await resolvePostbackLabel('action=pkg1_variant&value=1', {
      regionValue: 'brake',
      symptomIndex: 0,
    });
    expect(result).toBe('[操作] 「片側のみ」を選択');
  });

  it('数量を翻訳する', async () => {
    expect(await resolvePostbackLabel('action=pkg1_qty&value=2')).toBe('[操作] 数量「2」を選択');
  });

  it('カート操作を翻訳する', async () => {
    expect(await resolvePostbackLabel('action=pkg1_cart&value=add')).toBe('[操作] 他の整備も追加');
    expect(await resolvePostbackLabel('action=pkg1_cart&value=confirm')).toBe('[操作] 確認へ進む');
  });

  it('確認後の 3 択を翻訳する', async () => {
    expect(await resolvePostbackLabel('action=pkg1_confirm&value=pdf_only')).toBe(
      '[操作] PDF だけ受け取る',
    );
    expect(await resolvePostbackLabel('action=pkg1_confirm&value=reserve')).toBe(
      '[操作] ご来店予定を伝える',
    );
  });

  it('予約確定の分岐を翻訳する', async () => {
    expect(await resolvePostbackLabel('action=pkg1_reserve_confirm&value=ok')).toBe(
      '[操作] はい（予約確定）',
    );
    expect(await resolvePostbackLabel('action=pkg1_reserve_confirm&value=change')).toBe(
      '[操作] 別の日時にする',
    );
  });

  it('店舗 id を storeNameById で名称解決する', async () => {
    const result = await resolvePostbackLabel(
      'action=pkg1_reserve_store&value=11111111-2222-3333-4444-555555555555',
      { storeNameById: async () => '矢野口本店' },
    );
    expect(result).toBe('[操作] 「矢野口本店」を選択');
  });

  it('storeNameById が無ければ定型ラベルにフォールバックする', async () => {
    const result = await resolvePostbackLabel('action=pkg1_reserve_store&value=abc');
    expect(result).toBe('[操作] 店舗を選択');
  });

  it('来店日 (date) を整形して翻訳する', async () => {
    expect(await resolvePostbackLabel('action=pkg1_reserve_date&value=2026-06-25')).toBe(
      '[操作] ご来店日「6/25 00:00」を選択',
    );
  });

  it('来店日時 (time) を整形して翻訳する', async () => {
    expect(await resolvePostbackLabel('action=pkg1_reserve_time&value=2026-06-25t14:30')).toBe(
      '[操作] ご来店日時「6/25 14:30」を選択',
    );
  });

  it('Pkg1 postback でない通常テキストは null (翻訳不要)', async () => {
    expect(await resolvePostbackLabel('こんにちは')).toBeNull();
    expect(await resolvePostbackLabel('')).toBeNull();
    expect(await resolvePostbackLabel('action=foo&value=bar')).toBeNull();
  });
});
