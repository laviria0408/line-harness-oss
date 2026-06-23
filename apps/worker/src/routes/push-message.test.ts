import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { pushMessage } from './push-message.js';
import { validatePushMessages, isValidLineUserId, maskLineUserId } from '../lib/push-message-validate.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const INTERNAL_TOKEN = 'internal-shared-token';
const TENANT_ID = 'tenant-1';
const LINE_USER_ID = 'U' + 'a'.repeat(32);
const D1_TOKEN = 'd1-auto-refreshed-token'; // line_accounts.channel_access_token (最新)
const ENV_TOKEN = 'env-stale-token'; // fallback

type TestEnv = {
  Bindings: {
    SUPABASE_URL?: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
    TRYCLE_TENANT_ID?: string;
    DASHBOARD_INTERNAL_TOKEN?: string;
    LINE_CHANNEL_ACCESS_TOKEN?: string;
    DB?: unknown;
  };
};

/**
 * D1 を最小モック。SQL 文字列で friends / line_accounts を呼び分ける。
 * - opts.lineAccountId が null → friend は line_account_id なし (env fallback)
 * - opts.accountToken が undefined → account 行が無い (env fallback)
 */
function makeDb(opts: { lineAccountId?: string | null; accountToken?: string } = {}) {
  const { lineAccountId = 'acc-1', accountToken = D1_TOKEN } = opts;
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (sql.includes('FROM friends')) {
                return { line_account_id: lineAccountId } as unknown as T;
              }
              if (sql.includes('FROM line_accounts')) {
                return (accountToken !== undefined
                  ? ({ id: 'acc-1', channel_access_token: accountToken } as unknown)
                  : null) as T | null;
              }
              return null;
            },
          };
        },
      };
    },
  };
}

function baseEnv(overrides: Partial<TestEnv['Bindings']> = {}): TestEnv['Bindings'] {
  return {
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    TRYCLE_TENANT_ID: TENANT_ID,
    DASHBOARD_INTERNAL_TOKEN: INTERNAL_TOKEN,
    LINE_CHANNEL_ACCESS_TOKEN: ENV_TOKEN,
    DB: makeDb(),
    ...overrides,
  };
}

function buildApp() {
  const app = new Hono<TestEnv>();
  app.route('/', pushMessage);
  return app;
}

interface LineCall {
  token: string | null;
  body: unknown;
}

/**
 * fetch を stub。
 *   - supabase.test/rest/v1/cases … caseId → line_user_id
 *   - api.line.me/v2/bot/message/push … LINE Push (lineStatus で挙動制御)
 */
function installFetchStub(opts: {
  caseRow?: { line_user_id: string | null } | null;
  lineStatus?: number;
  lineBody?: string;
  lineCalls?: LineCall[];
}) {
  const { caseRow = { line_user_id: LINE_USER_ID }, lineStatus = 200, lineBody = '{}', lineCalls } = opts;
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/rest/v1/cases')) {
      return new Response(JSON.stringify(caseRow ? [caseRow] : []), { status: 200 });
    }
    if (url.startsWith('https://api.line.me/v2/bot/message/push')) {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      lineCalls?.push({
        token: auth ? auth.replace('Bearer ', '') : null,
        body: init?.body ? JSON.parse(init.body as string) : null,
      });
      return new Response(lineBody, { status: lineStatus });
    }
    return new Response('[]', { status: 200 });
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}

function post(app: ReturnType<typeof buildApp>, env: TestEnv['Bindings'], body: unknown, token = INTERNAL_TOKEN) {
  return app.request(
    '/api/cases/case-1/push-message',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env,
  );
}

const MESSAGES = [{ type: 'text', text: 'hello' }];

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ── pure helpers ──────────────────────────────────────────────────────────

describe('validatePushMessages', () => {
  test('valid messages array は ok', () => {
    expect(validatePushMessages({ messages: MESSAGES })).toEqual({ ok: true, messages: MESSAGES });
  });
  test('non-object body は reject', () => {
    expect(validatePushMessages(null).ok).toBe(false);
    expect(validatePushMessages('x').ok).toBe(false);
  });
  test('messages が配列でないと reject', () => {
    expect(validatePushMessages({ messages: 'x' }).ok).toBe(false);
  });
  test('空配列は reject', () => {
    expect(validatePushMessages({ messages: [] }).ok).toBe(false);
  });
  test('5 件超は reject (LINE Push 上限)', () => {
    const six = Array.from({ length: 6 }, () => ({ type: 'text', text: 'x' }));
    expect(validatePushMessages({ messages: six }).ok).toBe(false);
  });
  test('type が無い要素は reject', () => {
    expect(validatePushMessages({ messages: [{ text: 'x' }] }).ok).toBe(false);
  });
});

describe('isValidLineUserId', () => {
  test('U + 32 hex は valid', () => {
    expect(isValidLineUserId(LINE_USER_ID)).toBe(true);
  });
  test('短い / null / 形式違いは invalid', () => {
    expect(isValidLineUserId('U123')).toBe(false);
    expect(isValidLineUserId(null)).toBe(false);
    expect(isValidLineUserId('xyz')).toBe(false);
  });
});

describe('maskLineUserId', () => {
  test('生値を残さず先頭 4 文字 + 全長のみ', () => {
    const masked = maskLineUserId(LINE_USER_ID);
    expect(masked).not.toContain(LINE_USER_ID.slice(4));
    expect(masked).toBe('Uaaa…(33)');
  });
  test('null は (none)', () => {
    expect(maskLineUserId(null)).toBe('(none)');
  });
});

// ── route: auth ─────────────────────────────────────────────────────────────

describe('POST /api/cases/:caseId/push-message — 認証', () => {
  test('内部 token 不一致は 401', async () => {
    installFetchStub({});
    const res = await post(buildApp(), baseEnv(), { messages: MESSAGES }, 'wrong-token');
    expect(res.status).toBe(401);
  });

  test('token 未設定 (DASHBOARD_INTERNAL_TOKEN なし) は 503', async () => {
    installFetchStub({});
    const env = baseEnv({ DASHBOARD_INTERNAL_TOKEN: undefined });
    const res = await post(buildApp(), env, { messages: MESSAGES });
    expect(res.status).toBe(503);
  });
});

// ── route: 成功 / token 解決 ─────────────────────────────────────────────────

describe('POST /api/cases/:caseId/push-message — 成功', () => {
  test('成功時 200 + LINE に messages を中継する', async () => {
    const lineCalls: LineCall[] = [];
    installFetchStub({ lineCalls });
    const res = await post(buildApp(), baseEnv(), { messages: MESSAGES });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(lineCalls).toHaveLength(1);
    expect((lineCalls[0].body as { messages: unknown }).messages).toEqual(MESSAGES);
    expect((lineCalls[0].body as { to: string }).to).toBe(LINE_USER_ID);
  });

  test('D1 自動更新 token を最優先で使う (env token 乖離に影響されない)', async () => {
    const lineCalls: LineCall[] = [];
    installFetchStub({ lineCalls });
    const res = await post(buildApp(), baseEnv(), { messages: MESSAGES });
    expect(res.status).toBe(200);
    expect(lineCalls[0].token).toBe(D1_TOKEN);
    expect(lineCalls[0].token).not.toBe(ENV_TOKEN);
  });

  test('friend に line_account_id が無ければ env token に fallback', async () => {
    const lineCalls: LineCall[] = [];
    installFetchStub({ lineCalls });
    const env = baseEnv({ DB: makeDb({ lineAccountId: null }) });
    const res = await post(buildApp(), env, { messages: MESSAGES });
    expect(res.status).toBe(200);
    expect(lineCalls[0].token).toBe(ENV_TOKEN);
  });
});

// ── route: 検証 / エラー中継 ─────────────────────────────────────────────────

describe('POST /api/cases/:caseId/push-message — 検証 / エラー', () => {
  test('messages 空は 400', async () => {
    installFetchStub({});
    const res = await post(buildApp(), baseEnv(), { messages: [] });
    expect(res.status).toBe(400);
  });

  test('案件が無いと 404', async () => {
    installFetchStub({ caseRow: null });
    const res = await post(buildApp(), baseEnv(), { messages: MESSAGES });
    expect(res.status).toBe(404);
  });

  test('案件はあるが LINE 未連携 (line_user_id null) は 409', async () => {
    installFetchStub({ caseRow: { line_user_id: null } });
    const res = await post(buildApp(), baseEnv(), { messages: MESSAGES });
    expect(res.status).toBe(409);
  });

  test('LINE 400 は生 status + body を中継 (翻訳せず 502)', async () => {
    const lineBody = JSON.stringify({ message: 'Failed to send messages' });
    installFetchStub({ lineStatus: 400, lineBody });
    const res = await post(buildApp(), baseEnv(), { messages: MESSAGES });
    expect(res.status).toBe(502);
    const json = (await res.json()) as { success: boolean; status: number; error: string };
    expect(json.success).toBe(false);
    expect(json.status).toBe(400); // LINE の生 status を中継
    expect(json.error).toBe(lineBody); // 生 body をそのまま (翻訳は dashboard 側)
  });

  test('error response / log に line_user_id 生値が漏れない', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    installFetchStub({ lineStatus: 400, lineBody: '{"message":"Failed to send messages"}' });
    const res = await post(buildApp(), baseEnv(), { messages: MESSAGES });
    const text = await res.text();
    expect(text).not.toContain(LINE_USER_ID);
    // log にも生値が出ない (マスキング済のみ)。
    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain(LINE_USER_ID);
  });
});
