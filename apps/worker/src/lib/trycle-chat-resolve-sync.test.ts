import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import {
  isValidLineUserId,
  maskLineUserId,
  shouldSyncCaseComplete,
  syncCaseCompleteOnChatResolved,
  type ChatResolveSyncEnv,
} from './trycle-chat-resolve-sync.js';

const TENANT_ID = 'tenant-1';
const LINE_USER_ID = 'U' + 'a'.repeat(32);
const TALKING_ID = 'status-talking';
const DONE_ID = 'status-done';

function baseEnv(overrides: Partial<ChatResolveSyncEnv> = {}): ChatResolveSyncEnv {
  return {
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    TRYCLE_TENANT_ID: TENANT_ID,
    ...overrides,
  };
}

interface StubOptions {
  /** case_statuses で返す key 一覧 (talking/done)。 */
  statuses?: Array<{ id: string; key: string }>;
  /** cases SELECT で返す行数。 */
  talkingCases?: Array<{ id: string }>;
  /** PATCH (cases UPDATE) 呼び出しを捕捉する配列。 */
  patches?: Array<{ url: string; body: unknown }>;
  /** cases SELECT (GET) の URL を捕捉する配列。 */
  caseSelects?: string[];
}

/**
 * Supabase REST を fetch レベルでスタブ。URL とメソッドで case_statuses SELECT /
 * cases SELECT / cases PATCH を呼び分ける。
 */
function installFetchStub(opts: StubOptions = {}) {
  const statuses = opts.statuses ?? [
    { id: TALKING_ID, key: 'talking' },
    { id: DONE_ID, key: 'done' },
  ];
  const talkingCases = opts.talkingCases ?? [{ id: 'case-1' }];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/rest/v1/case_statuses')) {
        return new Response(JSON.stringify(statuses), { status: 200 });
      }
      if (url.includes('/rest/v1/cases') && method === 'GET') {
        opts.caseSelects?.push(url);
        return new Response(JSON.stringify(talkingCases), { status: 200 });
      }
      if (url.includes('/rest/v1/cases') && method === 'PATCH') {
        let body: unknown = null;
        try {
          body = init?.body ? JSON.parse(init.body as string) : null;
        } catch {
          body = init?.body ?? null;
        }
        opts.patches?.push({ url, body });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

describe('isValidLineUserId', () => {
  test('accepts U + 32 hex', () => {
    expect(isValidLineUserId(LINE_USER_ID)).toBe(true);
  });

  test('rejects malformed ids', () => {
    expect(isValidLineUserId('Uxyz')).toBe(false);
    expect(isValidLineUserId('')).toBe(false);
    expect(isValidLineUserId('friend-1')).toBe(false);
  });
});

describe('maskLineUserId', () => {
  test('keeps only the first 5 chars', () => {
    expect(maskLineUserId(LINE_USER_ID)).toBe('Uaaaa***');
  });

  test('fully masks short values', () => {
    expect(maskLineUserId('U123')).toBe('***');
  });
});

describe('shouldSyncCaseComplete', () => {
  test('fires only on transition into resolved', () => {
    expect(shouldSyncCaseComplete('resolved', 'in_progress')).toBe(true);
    expect(shouldSyncCaseComplete('resolved', 'unread')).toBe(true);
    expect(shouldSyncCaseComplete('resolved', undefined)).toBe(true);
  });

  test('does not fire when already resolved (no double trigger)', () => {
    expect(shouldSyncCaseComplete('resolved', 'resolved')).toBe(false);
  });

  test('does not fire for non-resolved targets', () => {
    expect(shouldSyncCaseComplete('in_progress', 'unread')).toBe(false);
    expect(shouldSyncCaseComplete(undefined, 'unread')).toBe(false);
  });
});

describe('syncCaseCompleteOnChatResolved', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('updates the talking case to done and reports count', async () => {
    const patches: Array<{ url: string; body: unknown }> = [];
    installFetchStub({ patches, talkingCases: [{ id: 'case-1' }] });

    const result = await syncCaseCompleteOnChatResolved(baseEnv(), LINE_USER_ID);

    expect(result.updatedCount).toBe(1);
    expect(result.skippedReason).toBeUndefined();
    expect(patches).toHaveLength(1);
    const body = patches[0].body as Record<string, unknown>;
    expect(body.status_id).toBe(DONE_ID);
    expect(typeof body.updated_at).toBe('string');
    // 単一 case を id 指定で更新 (1:1 連動)。旧 status_id を WHERE に残し競合上書きを防ぐ
    expect(patches[0].url).toContain('id=eq.case-1');
    expect(patches[0].url).toContain(`status_id=eq.${TALKING_ID}`);
    expect(patches[0].url).toContain('deleted_at=is.null');
  });

  test('updates only the newest talking case (1:1) when several exist', async () => {
    const patches: Array<{ url: string; body: unknown }> = [];
    const caseSelects: string[] = [];
    // SELECT は order=created_at.desc&limit=1 で最新 1 件のみを返す前提なので、
    // スタブは先頭 (= 最新) の 1 件だけ返す。複数残骸があっても巻き込まないことを保証。
    installFetchStub({ patches, caseSelects, talkingCases: [{ id: 'case-newest' }] });

    const result = await syncCaseCompleteOnChatResolved(baseEnv(), LINE_USER_ID);

    expect(result.updatedCount).toBe(1);
    // SELECT は最新 1 件に絞る (limit=1 + 降順)
    expect(caseSelects).toHaveLength(1);
    expect(caseSelects[0]).toContain('limit=1');
    expect(caseSelects[0]).toContain('order=created_at.desc');
    // PATCH は最新 case の id 1 件だけを対象にする (一括 UPDATE しない)
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toContain('id=eq.case-newest');
    // 旧仕様の「line_user_id で一括」ではない (生 line_user_id が WHERE に出ない)
    expect(patches[0].url).not.toContain(`line_user_id=eq.${LINE_USER_ID}`);
  });

  test('skips (no PATCH) when no talking case exists', async () => {
    const patches: Array<{ url: string; body: unknown }> = [];
    installFetchStub({ patches, talkingCases: [] });

    const result = await syncCaseCompleteOnChatResolved(baseEnv(), LINE_USER_ID);

    expect(result.updatedCount).toBe(0);
    expect(result.skippedReason).toBe('no-talking-case');
    expect(patches).toHaveLength(0);
  });

  test('skips when done status is not configured', async () => {
    const patches: Array<{ url: string; body: unknown }> = [];
    installFetchStub({ patches, statuses: [{ id: TALKING_ID, key: 'talking' }] });

    const result = await syncCaseCompleteOnChatResolved(baseEnv(), LINE_USER_ID);

    expect(result.updatedCount).toBe(0);
    expect(result.skippedReason).toBe('no-done-status');
    expect(patches).toHaveLength(0);
  });

  test('skips invalid line_user_id without touching supabase', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await syncCaseCompleteOnChatResolved(baseEnv(), 'friend-1');

    expect(result.skippedReason).toBe('invalid-line-user-id');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('skips when tenant is unset', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await syncCaseCompleteOnChatResolved(
      baseEnv({ TRYCLE_TENANT_ID: undefined }),
      LINE_USER_ID,
    );

    expect(result.skippedReason).toBe('tenant-unset');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('swallows supabase errors (best effort, never throws)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await syncCaseCompleteOnChatResolved(baseEnv(), LINE_USER_ID);

    expect(result.updatedCount).toBe(0);
    expect(result.skippedReason).toBe('error');
    // log には生の line_user_id を残さない
    const logged = errSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain(LINE_USER_ID);
    expect(logged).toContain('Uaaaa***');
  });
});
