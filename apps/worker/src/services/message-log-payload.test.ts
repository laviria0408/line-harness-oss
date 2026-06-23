import { describe, it, expect } from 'vitest';
import { messageToLogPayload, flexLogContent } from './step-delivery.js';
import { dispatchPrompt, regionMessages, symptomMessages } from '../lib/trycle-pkg1-flex.js';
import { REGIONS, findRegionByValue } from '../data/pkg1-regions.js';
import type { Message } from '@line-crm/line-sdk';

/**
 * Bug-C-001 regression: 会話履歴 (dashboard) で Flex メッセージが raw JSON で
 * dump されると UI が崩壊する。messages_log には altText だけを `[flex] ...`
 * 形式で残し、巨大な contents JSON は保存しないことをロックする。
 */
describe('messageToLogPayload (flex altText 抽出)', () => {
  it('flex は altText を [flex] prefix で保存する (raw JSON を捨てる)', () => {
    const message = {
      type: 'flex',
      altText: 'ご来店日 (14 候補)',
      contents: { type: 'bubble', size: 'giga', body: { type: 'box', layout: 'vertical', contents: [] } },
    } as unknown as Message;

    const payload = messageToLogPayload(message);

    expect(payload.messageType).toBe('flex');
    expect(payload.content).toBe('[flex] ご来店日 (14 候補)');
    // raw JSON の痕跡が残っていないこと。
    expect(payload.content).not.toContain('bubble');
    expect(payload.content).not.toContain('giga');
    expect(payload.content).not.toContain('{');
  });

  it('altText 欠落時は contents から先頭 text を救出する', () => {
    const message = {
      type: 'flex',
      altText: '',
      contents: {
        type: 'bubble',
        body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'ご確認ください' }] },
      },
    } as unknown as Message;

    expect(messageToLogPayload(message).content).toBe('[flex] ご確認ください');
  });

  it('altText も text も無いときは fail safe で [flex] のみ', () => {
    const message = {
      type: 'flex',
      altText: '',
      contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [] } },
    } as unknown as Message;

    expect(messageToLogPayload(message).content).toBe('[flex]');
  });

  it('template も altText を [flex] prefix で保存する', () => {
    const message = {
      type: 'template',
      altText: 'メニューを選択してください',
      template: { type: 'buttons', actions: [] },
    } as unknown as Message;

    const payload = messageToLogPayload(message);
    expect(payload.messageType).toBe('template');
    expect(payload.content).toBe('[flex] メニューを選択してください');
    expect(payload.content).not.toContain('buttons');
  });

  it('text はそのまま保存する (回帰なし)', () => {
    const message = { type: 'text', text: 'こんにちは' } as Message;
    expect(messageToLogPayload(message)).toEqual({ messageType: 'text', content: 'こんにちは' });
  });
});

describe('flexLogContent', () => {
  it('altText 文字列をトリムして使う', () => {
    expect(flexLogContent('  お見積り  ', undefined)).toBe('[flex] お見積り');
  });
  it('非文字列 altText は無視して contents 救出に倒す', () => {
    expect(flexLogContent(null, { type: 'text', text: '救出テキスト' })).toBe('[flex] 救出テキスト');
  });
  it('救出も失敗したら [flex]', () => {
    expect(flexLogContent(undefined, undefined)).toBe('[flex]');
  });
});

/**
 * Phase 1 (会話履歴の完全文脈化): Flex の altText だけでなく、本文中の選択肢
 * (tap row / button の action.label) を抽出して
 * 「📋 {altText}\n選択肢:\n- {A}\n- {B}…」形式で保存する。これで会話履歴だけで
 * 「bot が何を提示し、どの選択肢があったか」が読める。
 */
describe('flexLogContent — 選択肢ラベルの抽出 (Phase 1)', () => {
  it('tap row のラベルを 選択肢: リストとして抽出する', () => {
    const action = (label: string, value: string) => ({
      type: 'box',
      layout: 'horizontal',
      action: { type: 'postback', label, data: `action=pkg1_region&value=${value}` },
      contents: [{ type: 'text', text: label }],
    });
    const contents = {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: 'お困りの部位を選んでください' },
          action('ブレーキ', 'brake'),
          action('ホイール', 'wheel'),
          action('タイヤ', 'tire'),
        ],
      },
    };

    const result = flexLogContent('お困りの部位を選んでください', contents);

    expect(result).toBe(
      '[flex] お困りの部位を選んでください\n選択肢:\n- ブレーキ\n- ホイール\n- タイヤ',
    );
  });

  it('button の action.label も抽出する (text node が無いケース)', () => {
    const contents = {
      type: 'bubble',
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'button', action: { type: 'postback', label: 'はい', data: 'x=1' } },
          { type: 'button', action: { type: 'postback', label: 'いいえ', data: 'x=0' } },
        ],
      },
    };

    expect(flexLogContent('確認してください', contents)).toBe(
      '[flex] 確認してください\n選択肢:\n- はい\n- いいえ',
    );
  });

  it('見出し (altText) と同名のラベルは選択肢から除外する (重複防止)', () => {
    const contents = {
      type: 'bubble',
      body: {
        type: 'box',
        contents: [
          { type: 'box', action: { type: 'postback', label: '見出しと同じ', data: 'a=1' }, contents: [] },
          { type: 'box', action: { type: 'postback', label: '別の選択肢', data: 'a=2' }, contents: [] },
        ],
      },
    };
    expect(flexLogContent('見出しと同じ', contents)).toBe('[flex] 見出しと同じ\n選択肢:\n- 別の選択肢');
  });

  it('実 builder (dispatchPrompt 3 択) を完全文脈化する', () => {
    const msg = dispatchPrompt() as unknown as Message;
    const payload = messageToLogPayload(msg);
    expect(payload.content).toBe(
      '[flex] 整備見積もりを始めましょう\n選択肢:\n- 原因特定済み\n- 包括メンテしたい\n- 原因がわからない',
    );
  });

  it('実 builder (regionMessages 9 部位) を完全文脈化する', () => {
    const msgs = regionMessages(REGIONS);
    // 単一 bubble に収まる (9 部位)。
    const payload = messageToLogPayload(msgs[0] as unknown as Message);
    expect(payload.content).toContain('[flex] お困りの部位を選んでください');
    expect(payload.content).toContain('選択肢:');
    for (const region of REGIONS) {
      expect(payload.content).toContain(`- ${region.label}`);
    }
  });

  it('実 builder (symptomMessages タイヤ関係) を完全文脈化する', () => {
    const tire = findRegionByValue('tire')!;
    const msgs = symptomMessages(tire);
    const payload = messageToLogPayload(msgs[0] as unknown as Message);
    expect(payload.content).toContain('- パンク修理');
    expect(payload.content).toContain('- シーラント注入');
  });

  it('選択肢が無い Flex は 見出しだけ (回帰なし)', () => {
    const contents = {
      type: 'bubble',
      body: { type: 'box', contents: [{ type: 'text', text: '本文のみ' }] },
    };
    expect(flexLogContent('お知らせ', contents)).toBe('[flex] お知らせ');
  });
});
