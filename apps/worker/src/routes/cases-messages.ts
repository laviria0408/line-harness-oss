/**
 * TRYCLE 案件詳細「会話履歴タブ」用 messages_log fetch API。
 *
 * 設計: memory `project_trycle_conversation_history_spec` v1.4 §3 (2026-06-23)。
 *
 *   GET /api/cases/:caseId/messages?cursor=&limit=
 *
 * ## ソースの繋ぎ
 * 案件 (cases) は Supabase・会話履歴 (messages_log) は D1 に分かれている:
 *   caseId → cases.line_user_id (Supabase, tenant スコープ)
 *          → friends.id        (D1, line_user_id は UNIQUE)
 *          → messages_log      (D1, friend_id でフィルタ)
 *
 * ## 認証
 * staff 認証 (authMiddleware) は bypass し、内部共有 token で守る:
 *   Authorization: Bearer <DASHBOARD_INTERNAL_TOKEN>
 * dashboard (Vercel) の server 側だけが token を持ち、ブラウザには出さない。
 *
 * ## PII マスキング
 * line_user_id 生値は response に含めない (内部 friend_id のみ)。
 *
 * ## direction の正規化 (bot | staff | user)
 *   incoming                         → user
 *   outgoing & source='manual'       → staff (有人返信)
 *   outgoing & その他 (scenario/broadcast/auto_reply/Pkg1/Pkg8 等) → bot
 */
import { Hono } from 'hono';
import type { Env } from '../index.js';
import { supabaseSelect } from '../lib/supabase.js';

export const casesMessages = new Hono<Env>();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export type MessageDirection = 'bot' | 'staff' | 'user';

export interface ConversationMessage {
  readonly id: string;
  readonly direction: MessageDirection;
  readonly timestamp: string;
  readonly text: string;
}

interface MessagesLogRow {
  readonly id: string;
  readonly direction: 'incoming' | 'outgoing';
  readonly message_type: string;
  readonly content: string | null;
  readonly delivery_type: string | null;
  readonly source: string | null;
  readonly broadcast_id: string | null;
  readonly scenario_step_id: string | null;
  readonly created_at: string;
}

/**
 * messages_log の 1 行を会話履歴の direction (bot|staff|user) へ正規化する。
 * conversations.ts の source 推論ルールと整合させる (migration 028 のバックフィル
 * 規則と同じ): source が NULL でも FK/delivery_type から自動分類する。
 */
export function normalizeDirection(row: {
  direction: 'incoming' | 'outgoing';
  source: string | null;
  delivery_type: string | null;
  broadcast_id: string | null;
  scenario_step_id: string | null;
}): MessageDirection {
  if (row.direction === 'incoming') return 'user';
  const source =
    row.source ??
    (row.scenario_step_id
      ? 'scenario'
      : row.broadcast_id || row.delivery_type === 'test'
        ? 'broadcast'
        : row.delivery_type === 'reply'
          ? 'auto_reply'
          : 'manual');
  // 有人 (manual) のみ staff・それ以外の自動配信は bot。
  return source === 'manual' ? 'staff' : 'bot';
}

/** non-text メッセージは content が JSON / 空のことがあるため簡易ラベル化する。 */
function displayText(row: MessagesLogRow): string {
  if (row.message_type === 'text' && row.content) return row.content;
  if (row.content && row.content.trim().length > 0) return row.content;
  switch (row.message_type) {
    case 'image':
      return '[画像]';
    case 'sticker':
      return '[スタンプ]';
    case 'video':
      return '[動画]';
    case 'audio':
      return '[音声]';
    case 'location':
      return '[位置情報]';
    case 'file':
      return '[ファイル]';
    case 'flex':
    case 'template':
      return '[メッセージ]';
    default:
      return `[${row.message_type}]`;
  }
}

casesMessages.get('/api/cases/:caseId/messages', async (c) => {
  // 内部 token 認証 (staff auth は bypass されている)。
  const expected = c.env.DASHBOARD_INTERNAL_TOKEN;
  if (!expected) {
    return c.json({ success: false, error: 'internal token not configured' }, 503);
  }
  const auth = c.req.header('Authorization');
  const token = auth && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null;
  if (!token || token !== expected) {
    return c.json({ success: false, error: 'unauthorized' }, 401);
  }

  const caseId = c.req.param('caseId');
  const url = new URL(c.req.url);
  const limit = Math.min(
    Math.max(Number(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT)) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const cursor = url.searchParams.get('cursor'); // created_at の ISO 文字列 (これより古いものを取る)

  try {
    // 1) caseId → line_user_id (Supabase・tenant スコープ)
    const tenantId = c.env.TRYCLE_TENANT_ID;
    if (!tenantId) {
      return c.json({ success: false, error: 'tenant not configured' }, 503);
    }
    const caseRows = await supabaseSelect<{ line_user_id: string | null }>(
      c.env,
      'cases',
      { id: `eq.${caseId}`, tenant_id: `eq.${tenantId}` },
      { select: 'line_user_id', limit: 1 },
    );
    const lineUserId = caseRows[0]?.line_user_id ?? null;
    if (!caseRows[0]) {
      return c.json({ success: false, error: 'case not found' }, 404);
    }
    // case はあるが LINE 未連携 (dashboard 起票) → 空配列。
    if (!lineUserId) {
      return c.json({ success: true, data: { messages: [], nextCursor: null } });
    }

    // 2) line_user_id → friend_id (D1・line_user_id は UNIQUE)
    const friend = await c.env.DB.prepare(`SELECT id FROM friends WHERE line_user_id = ?`)
      .bind(lineUserId)
      .first<{ id: string }>();
    if (!friend) {
      // LINE Harness が未取り込み → 履歴なし。
      return c.json({ success: true, data: { messages: [], nextCursor: null } });
    }

    // 3) messages_log (D1・friend_id フィルタ・newest first・cursor pagination)
    //    julianday() で sub-second / TZ 差を吸収する (conversations.ts と同方針)。
    const sql = cursor
      ? `SELECT id, direction, message_type, content, delivery_type, source, broadcast_id, scenario_step_id, created_at
         FROM messages_log
         WHERE friend_id = ? AND julianday(created_at) < julianday(?)
         ORDER BY created_at DESC LIMIT ?`
      : `SELECT id, direction, message_type, content, delivery_type, source, broadcast_id, scenario_step_id, created_at
         FROM messages_log
         WHERE friend_id = ?
         ORDER BY created_at DESC LIMIT ?`;
    // limit+1 を取って次ページ有無を判定する。
    const bindings: (string | number)[] = cursor
      ? [friend.id, cursor, limit + 1]
      : [friend.id, limit + 1];
    const { results } = await c.env.DB.prepare(sql)
      .bind(...bindings)
      .all<MessagesLogRow>();

    const hasMore = results.length > limit;
    const page = hasMore ? results.slice(0, limit) : results;
    const messages: ConversationMessage[] = page.map((row) => ({
      id: row.id,
      direction: normalizeDirection(row),
      timestamp: row.created_at,
      text: displayText(row),
    }));
    const nextCursor = hasMore ? page[page.length - 1]?.created_at ?? null : null;

    return c.json({ success: true, data: { messages, nextCursor } });
  } catch (err) {
    console.error('GET /api/cases/:caseId/messages error:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});
