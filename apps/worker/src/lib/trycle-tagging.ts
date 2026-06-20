/**
 * TRYCLE auto-tagging on business events (Phase B-5).
 *
 * Business events → tags applied on the LINE friend (LINE Harness `friends` /
 * `tags` / `friend_tags` tables):
 *
 *   - 同意取得     → "TRYCLE:同意取得済"
 *   - 見積もり完了 → "TRYCLE:見積もり済"
 *   - 来店予約     → "TRYCLE:予約済"
 *
 * These tags drive segmented broadcasts and dashboard cohort filters via the
 * LINE Harness standard tag UI — TRYCLE does not need its own audience module.
 *
 * Idempotent: `INSERT OR IGNORE` for tag lookups and friend_tags join, so it
 * is safe to call on every event without de-dup tracking.
 *
 * Errors do NOT throw — auto-tagging is best-effort. A failed tag insert must
 * not break the business reply to the user (consent acknowledged / quote
 * delivered). Failures are logged via console.error for Worker tail logs.
 */

import type { Env } from '../index.js';

export const TRYCLE_TAG_CONSENT = 'TRYCLE:同意取得済';
export const TRYCLE_TAG_QUOTE = 'TRYCLE:見積もり済';
export const TRYCLE_TAG_RESERVATION = 'TRYCLE:予約済';

const TRYCLE_TAG_COLOR = '#F97316';

export type TrycleTagName =
  | typeof TRYCLE_TAG_CONSENT
  | typeof TRYCLE_TAG_QUOTE
  | typeof TRYCLE_TAG_RESERVATION;

/**
 * Look up (and lazily create) the LINE Harness tag row. Returns the tag id.
 *
 * Uses `INSERT OR IGNORE` then `SELECT` so concurrent webhooks colliding on
 * the same tag name don't race — the unique index on `tags.name` is the
 * arbiter.
 */
export async function ensureTagByName(
  db: D1Database,
  name: string,
  color: string = TRYCLE_TAG_COLOR,
): Promise<string | null> {
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(`INSERT OR IGNORE INTO tags (id, name, color) VALUES (?, ?, ?)`)
      .bind(id, name, color)
      .run();
    const row = await db
      .prepare(`SELECT id FROM tags WHERE name = ?`)
      .bind(name)
      .first<{ id: string }>();
    return row?.id ?? null;
  } catch (err) {
    console.error('[trycle-tagging] ensureTagByName failed', { name, err });
    return null;
  }
}

/**
 * Resolve friend.id from line_user_id. Returns null if the LINE Harness has
 * not yet ingested this friend (which can happen if the business endpoint is
 * called before the user follows the OA — we just skip tagging then).
 */
export async function findFriendIdByLineUserId(
  db: D1Database,
  lineUserId: string,
): Promise<string | null> {
  try {
    const row = await db
      .prepare(`SELECT id FROM friends WHERE line_user_id = ?`)
      .bind(lineUserId)
      .first<{ id: string }>();
    return row?.id ?? null;
  } catch (err) {
    console.error('[trycle-tagging] findFriendIdByLineUserId failed', {
      lineUserId,
      err,
    });
    return null;
  }
}

/**
 * Assign a tag to a friend (idempotent — INSERT OR IGNORE on composite PK).
 */
export async function assignTagToFriend(
  db: D1Database,
  friendId: string,
  tagId: string,
): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO friend_tags (friend_id, tag_id) VALUES (?, ?)`,
      )
      .bind(friendId, tagId)
      .run();
    return true;
  } catch (err) {
    console.error('[trycle-tagging] assignTagToFriend failed', {
      friendId,
      tagId,
      err,
    });
    return false;
  }
}

/**
 * Convenience: ensure tag + resolve friend + assign. Returns true if the
 * friend was tagged or was already tagged. Returns false if the friend has
 * not been ingested into the LINE Harness yet (i.e. tagging is silently
 * skipped — see comment above).
 */
export async function tagFriendByLineUserId(
  env: Env['Bindings'],
  lineUserId: string,
  tagName: TrycleTagName,
): Promise<boolean> {
  const db = env.DB;
  const friendId = await findFriendIdByLineUserId(db, lineUserId);
  if (!friendId) return false;
  const tagId = await ensureTagByName(db, tagName);
  if (!tagId) return false;
  return assignTagToFriend(db, friendId, tagId);
}
