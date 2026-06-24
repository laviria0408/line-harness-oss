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
import { resolveCaseConversationRange, resolveCaseLineUserId, verifyDashboardToken } from '../lib/dashboard-auth.js';

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
  const authResult = verifyDashboardToken(c);
  if (!authResult.ok) {
    return c.json({ success: false, error: authResult.error }, authResult.status);
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
    const lookup = await resolveCaseLineUserId(c, caseId);
    if (lookup.status === 'tenant_unconfigured') {
      return c.json({ success: false, error: 'tenant not configured' }, 503);
    }
    if (lookup.status === 'not_found') {
      return c.json({ success: false, error: 'case not found' }, 404);
    }
    const lineUserId = lookup.lineUserId;
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

    // 2.5) 当 case の時間範囲を取る。messages_log は friend 単位で全件保存されているため、
    //      friend_id だけで絞ると同顧客の過去 case の会話も全部出てしまう (実機 bug 修正)。
    //      当 case の created_at 〜 同 line_user_id の次 case の created_at 直前まで。
    //      次 case が無ければ「現在まで (上限なし)」。
    const range = await resolveCaseConversationRange(c, caseId);
    const startAt = range.status === 'ok' ? range.startAt ?? null : null;
    const endAt = range.status === 'ok' ? range.endAt ?? null : null;

    // 3) messages_log (D1・friend_id + 時間範囲・newest first・cursor pagination)
    //    julianday() で sub-second / TZ 差を吸収する (conversations.ts と同方針)。
    const whereClauses: string[] = ['friend_id = ?'];
    const baseBindings: (string | number)[] = [friend.id];
    if (startAt) {
      // 前 case の created_at より新しい (= 前 case 終了後)。境界一致は前 case 側にする。
      whereClauses.push('julianday(created_at) > julianday(?)');
      baseBindings.push(startAt);
    }
    if (endAt) {
      // 次 case の created_at 以前 (= 当 case 完了まで)。境界一致は当 case 側に含める。
      whereClauses.push('julianday(created_at) <= julianday(?)');
      baseBindings.push(endAt);
    }
    if (cursor) {
      whereClauses.push('julianday(created_at) < julianday(?)');
      baseBindings.push(cursor);
    }
    const sql = `SELECT id, direction, message_type, content, delivery_type, source, broadcast_id, scenario_step_id, created_at
         FROM messages_log
         WHERE ${whereClauses.join(' AND ')}
         ORDER BY created_at DESC LIMIT ?`;
    // limit+1 を取って次ページ有無を判定する。
    const bindings: (string | number)[] = [...baseBindings, limit + 1];
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
