/**
 * trycle-outgoing-log のユニットテスト (2026-06-23 真因 4)。
 *
 * 検証:
 *   - reply / push した bot メッセージが messages_log に **outgoing** で記録される。
 *   - direction='outgoing' + source(pkg1/pkg8) で記録され、案件詳細の
 *     normalizeDirection が bot (右側) に分類できる形になる。
 *   - friend 未登録なら記録をスキップ (best-effort・throw しない)。
 *   - flex / text 双方の content が messageToLogPayload 経由で正しく入る。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// @line-crm/db の friend 解決 + jstNow を mock する。
const getFriendByLineUserId = vi.fn();
vi.mock('@line-crm/db', () => ({
  getFriendByLineUserId: (...args: unknown[]) => getFriendByLineUserId(...args),
  jstNow: () => '2026-06-23T11:20:00.000+09:00',
}));

import { recordOutgoingMessages } from './trycle-outgoing-log.js';
import { normalizeDirection } from '../routes/cases-messages.js';

interface CapturedInsert {
  sql: string;
  bindings: unknown[];
}

/** INSERT を捕捉する最小 D1 スタブ。 */
function fakeDb(captured: CapturedInsert[]): { DB: D1Database } {
  const prepare = (sql: string) => {
    const stmt = {
      bind: (...bindings: unknown[]) => {
        return {
          run: async () => {
            captured.push({ sql, bindings });
            return { success: true } as unknown;
          },
        };
      },
    };
    return stmt as unknown as D1PreparedStatement;
  };
  return { DB: { prepare } as unknown as D1Database };
}

describe('recordOutgoingMessages (真因 4: bot outgoing 記録)', () => {
  beforeEach(() => {
    getFriendByLineUserId.mockReset();
  });

  it('reply した text/flex を outgoing として messages_log に記録する', async () => {
    getFriendByLineUserId.mockResolvedValue({ id: 'friend-1' });
    const captured: CapturedInsert[] = [];
    const env = fakeDb(captured);

    await recordOutgoingMessages(
      env,
      'U_taro',
      [
        { type: 'text', text: 'ご来店店舗をお選びください。' },
        { type: 'flex', altText: 'メニュー', contents: { type: 'bubble' } },
      ],
      'reply',
      'pkg1',
    );

    expect(captured).toHaveLength(2);
    // 各 INSERT は direction='outgoing' を固定文字列で持つ。
    for (const ins of captured) {
      expect(ins.sql).toContain("'outgoing'");
      expect(ins.sql).toContain('messages_log');
    }
    // bindings: [id, friend_id, message_type, content, delivery_type, source, created_at]
    const [textIns, flexIns] = captured;
    expect(textIns.bindings[1]).toBe('friend-1');
    expect(textIns.bindings[2]).toBe('text');
    expect(textIns.bindings[3]).toBe('ご来店店舗をお選びください。');
    expect(textIns.bindings[4]).toBe('reply');
    expect(textIns.bindings[5]).toBe('pkg1');

    expect(flexIns.bindings[2]).toBe('flex');
    // Bug-C-001: Flex は raw JSON でなく altText を [flex] prefix で保存する
    // (dashboard 会話履歴で JSON dump させない)。
    expect(flexIns.bindings[3]).toBe('[flex] メニュー');
    expect(flexIns.bindings[3] as string).not.toContain('bubble');
  });

  it('記録した行は normalizeDirection で bot (右側) に分類される', async () => {
    getFriendByLineUserId.mockResolvedValue({ id: 'friend-1' });
    const captured: CapturedInsert[] = [];
    await recordOutgoingMessages(fakeDb(captured), 'U_taro', [{ type: 'text', text: 'hi' }], 'reply', 'pkg8');
    const source = captured[0].bindings[5] as string;
    // pkg8 は manual ではない → bot。
    expect(
      normalizeDirection({
        direction: 'outgoing',
        source,
        delivery_type: 'reply',
        broadcast_id: null,
        scenario_step_id: null,
      }),
    ).toBe('bot');
  });

  it('friend 未登録なら記録をスキップ (throw しない)', async () => {
    getFriendByLineUserId.mockResolvedValue(null);
    const captured: CapturedInsert[] = [];
    await expect(
      recordOutgoingMessages(fakeDb(captured), 'U_unknown', [{ type: 'text', text: 'hi' }], 'reply'),
    ).resolves.toBeUndefined();
    expect(captured).toHaveLength(0);
  });

  it('空メッセージ配列なら no-op (friend 解決もしない)', async () => {
    const captured: CapturedInsert[] = [];
    await recordOutgoingMessages(fakeDb(captured), 'U_taro', [], 'push');
    expect(getFriendByLineUserId).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it('記録失敗 (D1 throw) でもフローを止めない', async () => {
    getFriendByLineUserId.mockResolvedValue({ id: 'friend-1' });
    const throwingDb = {
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => {
              throw new Error('D1 down');
            },
          }),
        }),
      } as unknown as D1Database,
    };
    await expect(
      recordOutgoingMessages(throwingDb, 'U_taro', [{ type: 'text', text: 'hi' }], 'push'),
    ).resolves.toBeUndefined();
  });
});
