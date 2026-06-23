import { describe, it, expect } from 'vitest';
import { messageToLogPayload, flexLogContent } from './step-delivery.js';
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
