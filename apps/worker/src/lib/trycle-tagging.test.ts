import { describe, it, expect, beforeEach } from 'vitest';
import {
  ensureTagByName,
  findFriendIdByLineUserId,
  assignTagToFriend,
  tagFriendByLineUserId,
  TRYCLE_TAG_CONSENT,
  TRYCLE_TAG_QUOTE,
} from './trycle-tagging.js';

/**
 * Tiny in-memory D1 stub. Covers only the SQL shapes used by trycle-tagging:
 *   - INSERT OR IGNORE INTO tags(id, name, color)
 *   - SELECT id FROM tags WHERE name = ?
 *   - SELECT id FROM friends WHERE line_user_id = ?
 *   - INSERT OR IGNORE INTO friend_tags(friend_id, tag_id)
 *
 * We don't try to be a SQLite engine — we just match prefixes and store rows.
 */
function makeStubDb(initialFriends: { id: string; line_user_id: string }[]) {
  const tags = new Map<string, { id: string; name: string; color: string }>();
  const friends = new Map<string, string>();
  for (const f of initialFriends) friends.set(f.line_user_id, f.id);
  const friendTags = new Set<string>();

  const db = {
    prepare(sql: string) {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (trimmed.startsWith('INSERT OR IGNORE INTO tags')) {
                const [id, name, color] = args as [string, string, string];
                if (![...tags.values()].some((t) => t.name === name)) {
                  tags.set(id, { id, name, color });
                }
                return;
              }
              if (trimmed.startsWith('INSERT OR IGNORE INTO friend_tags')) {
                const [friendId, tagId] = args as [string, string];
                friendTags.add(`${friendId}:${tagId}`);
                return;
              }
              throw new Error(`unstubbed run() SQL: ${trimmed}`);
            },
            async first<T>() {
              if (trimmed.startsWith('SELECT id FROM tags WHERE name')) {
                const [name] = args as [string];
                const row = [...tags.values()].find((t) => t.name === name);
                return (row ? ({ id: row.id } as unknown as T) : null) as T | null;
              }
              if (
                trimmed.startsWith('SELECT id FROM friends WHERE line_user_id')
              ) {
                const [lineUserId] = args as [string];
                const id = friends.get(lineUserId);
                return (id ? ({ id } as unknown as T) : null) as T | null;
              }
              throw new Error(`unstubbed first() SQL: ${trimmed}`);
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  return { db, tags, friends, friendTags };
}

describe('trycle-tagging', () => {
  let stub: ReturnType<typeof makeStubDb>;

  beforeEach(() => {
    stub = makeStubDb([
      { id: 'friend-1', line_user_id: 'Uabc' },
      { id: 'friend-2', line_user_id: 'Udef' },
    ]);
  });

  describe('ensureTagByName', () => {
    it('creates a tag if it does not exist and returns its id', async () => {
      const id = await ensureTagByName(stub.db, TRYCLE_TAG_CONSENT);
      expect(id).toBeTruthy();
      expect([...stub.tags.values()].some((t) => t.name === TRYCLE_TAG_CONSENT)).toBe(true);
    });

    it('returns the existing tag id on second call (idempotent)', async () => {
      const id1 = await ensureTagByName(stub.db, TRYCLE_TAG_CONSENT);
      const id2 = await ensureTagByName(stub.db, TRYCLE_TAG_CONSENT);
      expect(id1).toBe(id2);
      expect(stub.tags.size).toBe(1);
    });
  });

  describe('findFriendIdByLineUserId', () => {
    it('returns the friend id when found', async () => {
      const id = await findFriendIdByLineUserId(stub.db, 'Uabc');
      expect(id).toBe('friend-1');
    });

    it('returns null when not found', async () => {
      const id = await findFriendIdByLineUserId(stub.db, 'Uxxx');
      expect(id).toBeNull();
    });
  });

  describe('assignTagToFriend', () => {
    it('inserts the join row and returns true', async () => {
      const ok = await assignTagToFriend(stub.db, 'friend-1', 'tag-1');
      expect(ok).toBe(true);
      expect(stub.friendTags.has('friend-1:tag-1')).toBe(true);
    });
  });

  describe('tagFriendByLineUserId', () => {
    it('ensures tag, resolves friend, and assigns', async () => {
      const env = { DB: stub.db } as unknown as Parameters<typeof tagFriendByLineUserId>[0];
      const ok = await tagFriendByLineUserId(env, 'Uabc', TRYCLE_TAG_QUOTE);
      expect(ok).toBe(true);
      const tagId = [...stub.tags.values()].find(
        (t) => t.name === TRYCLE_TAG_QUOTE,
      )?.id;
      expect(tagId).toBeTruthy();
      expect(stub.friendTags.has(`friend-1:${tagId}`)).toBe(true);
    });

    it('returns false when the friend is not yet ingested (no throw)', async () => {
      const env = { DB: stub.db } as unknown as Parameters<typeof tagFriendByLineUserId>[0];
      const ok = await tagFriendByLineUserId(env, 'Uxxx-not-yet', TRYCLE_TAG_QUOTE);
      expect(ok).toBe(false);
    });

    it('is idempotent across multiple calls', async () => {
      const env = { DB: stub.db } as unknown as Parameters<typeof tagFriendByLineUserId>[0];
      await tagFriendByLineUserId(env, 'Uabc', TRYCLE_TAG_CONSENT);
      await tagFriendByLineUserId(env, 'Uabc', TRYCLE_TAG_CONSENT);
      await tagFriendByLineUserId(env, 'Uabc', TRYCLE_TAG_CONSENT);
      expect(stub.tags.size).toBe(1);
      const tagId = [...stub.tags.values()][0].id;
      expect(stub.friendTags.has(`friend-1:${tagId}`)).toBe(true);
      expect(stub.friendTags.size).toBe(1);
    });
  });
});
