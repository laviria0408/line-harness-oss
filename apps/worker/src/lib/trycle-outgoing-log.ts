/**
 * TRYCLE bot 送信 (reply / push) の outgoing 記録ヘルパー (LH 拡張)。
 *
 * ## なぜ要るか (2026-06-23 真因 4)
 * LH 標準は manual outgoing (chats.ts の operator 送信) と auto_reply / scenario /
 * broadcast の送信だけを messages_log に書き込む。**Pkg1 / Pkg8 の dispatcher が
 * 直接 lineClient.replyMessage / pushMessage した bot 応答は記録されない**。
 * 結果、整備見積・FAQ フローの messages_log は incoming 行だけになり、案件詳細
 * 「会話履歴」タブ (cases-messages.ts の normalizeDirection: outgoing→bot/staff) が
 * 全 entry を user (左・青) 表示してしまう。
 *
 * そこで Pkg1 / Pkg8 が送信した直後にこのヘルパーで outgoing を記録する。
 * source は既定 'pkg1' / 'pkg8' 等の自動配信扱い → normalizeDirection で 'bot' に
 * なる (manual だけが staff)。delivery_type は reply / push を渡す。
 *
 * ## 設計上の都合
 * - messages_log は **D1** (`env.DB`)・cases/bot_sessions は Supabase。よって
 *   このヘルパーは env.DB を要求する。Pkg1/Pkg8  context の env は Env['Bindings']
 *   実体なので DB を持つ (型は narrow でも実体は同一)。
 * - friend_id 解決は line_user_id → friends.id (D1, line_user_id UNIQUE)。
 *   friend 未登録 (webhook 未処理) のときは記録をスキップ (best-effort)。
 * - 記録失敗はフローを止めない (送信は成功している)。catch して console.error。
 */
import { getFriendByLineUserId, jstNow } from '@line-crm/db';
import type { Message } from '@line-crm/line-sdk';
import { messageToLogPayload } from '../services/step-delivery.js';

/** outgoing 記録に最低限必要な binding (env.DB のみ)。 */
export interface OutgoingLogEnv {
  readonly DB: D1Database;
}

export type OutgoingDeliveryType = 'reply' | 'push';

/**
 * Pkg1/Pkg8 の LineMessage (loose な {type, [key]: unknown}) も受けられるよう
 * 構造的に最小の型で受ける。messageToLogPayload には Message として渡す。
 */
export type LooseMessage = { readonly type: string; readonly [key: string]: unknown };

/**
 * bot が送った messages を messages_log へ outgoing として記録する。
 *
 * @param env          env.DB (D1) を持つ binding。
 * @param lineUserId   宛先 LINE userId (friend 解決に使う)。
 * @param messages     実際に送った Message 配列 (replyMessage/pushMessage の引数と同一)。
 * @param deliveryType 'reply' (replyMessage) / 'push' (pushMessage)。
 * @param source       messages_log.source。既定 'pkg1' (自動配信扱い→bot 表示)。
 */
export async function recordOutgoingMessages(
  env: OutgoingLogEnv,
  lineUserId: string,
  messages: ReadonlyArray<LooseMessage>,
  deliveryType: OutgoingDeliveryType,
  source = 'pkg1',
): Promise<void> {
  if (messages.length === 0) return;
  try {
    const friend = await getFriendByLineUserId(env.DB, lineUserId);
    if (!friend) {
      // friend 未登録は webhook 未処理。送信自体は成立しているが履歴は紐付け先が
      // 無いのでスキップ (best-effort・通常起こらない)。
      console.warn('[trycle-outgoing-log] friend not found, skip log', lineUserId);
      return;
    }
    const now = jstNow();
    for (const message of messages) {
      const payload = messageToLogPayload(message as unknown as Message);
      await env.DB.prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, ?, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          friend.id,
          payload.messageType,
          payload.content,
          deliveryType,
          source,
          now,
        )
        .run();
    }
  } catch (err) {
    console.error('[trycle-outgoing-log] recordOutgoingMessages failed', err);
  }
}
