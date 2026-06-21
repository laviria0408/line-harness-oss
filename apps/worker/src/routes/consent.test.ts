import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { consent, parseCallbackBody } from './consent.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

type TestEnv = {
  Bindings: {
    SUPABASE_URL?: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
    TRYCLE_TENANT_ID?: string;
    DB?: unknown;
    LINE_LOGIN_CHANNEL_ID?: string;
  };
};

const ENV: TestEnv['Bindings'] = {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  TRYCLE_TENANT_ID: 'tenant-1',
};

const LINE_USER_ID = 'U1234567890';
const ACCESS_TOKEN = 'valid-access-token';

function buildApp() {
  const app = new Hono<TestEnv>();
  app.route('/', consent);
  return app;
}

/**
 * fetch を stub し、LINE Profile API / Supabase REST の呼び分けを行う。
 *   - api.line.me/v2/profile … access_token verify
 *   - supabase.test/rest/v1/consent_documents … 文面取得
 *   - supabase.test/rest/v1/customers|consents|... … upsert / tagging
 */
function installFetchStub(opts: {
  profileOk?: boolean;
  document?: { id: string; version: string; title: string; body_md: string } | null;
}) {
  const { profileOk = true, document = null } = opts;
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://api.line.me/v2/profile')) {
      if (!profileOk) return new Response('forbidden', { status: 401 });
      return new Response(JSON.stringify({ userId: LINE_USER_ID }), { status: 200 });
    }
    if (url.includes('/rest/v1/consent_documents')) {
      return new Response(JSON.stringify(document ? [document] : []), { status: 200 });
    }
    // customers / consents upsert + tagging selects: respond OK.
    return new Response(JSON.stringify([]), { status: 200 });
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseCallbackBody', () => {
  const valid = {
    line_user_id: LINE_USER_ID,
    access_token: ACCESS_TOKEN,
    consent_document_version: 'v1.0 (2026-06-21)',
    confirmation_screen_shown_at: '2026-06-21T06:00:00.000Z',
    name: '田中 一郎',
    kana: 'たなか いちろう',
    phone: '08011112222',
    address: '東京都調布市1-1',
    email: 'taro@example.com',
    monthly_distance: '150',
  };

  test('maps snake_case body to a typed callback shape', () => {
    const parsed = parseCallbackBody(valid);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.lineUserId).toBe(LINE_USER_ID);
    expect(parsed.accessToken).toBe(ACCESS_TOKEN);
    expect(parsed.consentDocumentVersion).toBe('v1.0 (2026-06-21)');
    expect(parsed.confirmationScreenShownAt).toBe('2026-06-21T06:00:00.000Z');
    expect(parsed.name).toBe('田中 一郎');
    expect(parsed.kana).toBe('たなか いちろう');
    expect(parsed.phone).toBe('08011112222');
    expect(parsed.address).toBe('東京都調布市1-1');
    expect(parsed.email).toBe('taro@example.com');
    expect(parsed.monthlyDistance).toBe('150');
  });

  test('rejects when required fields are missing (incl. kana)', () => {
    for (const key of [
      'line_user_id',
      'consent_document_version',
      'confirmation_screen_shown_at',
      'name',
      'kana',
      'phone',
    ]) {
      const body: Record<string, unknown> = { ...valid };
      delete body[key];
      const parsed = parseCallbackBody(body);
      expect(parsed.ok).toBe(false);
    }
  });

  test('allows optional fields (address/email/monthly_distance) to be absent', () => {
    const { address, email, monthly_distance, ...required } = valid;
    void address;
    void email;
    void monthly_distance;
    const parsed = parseCallbackBody(required);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.address).toBe('');
    expect(parsed.email).toBe('');
    expect(parsed.monthlyDistance).toBe('');
  });

  test('accepts monthly_distance as a number or a unit-suffixed string', () => {
    const asNumber = parseCallbackBody({ ...valid, monthly_distance: 200 });
    expect(asNumber.ok).toBe(true);
    if (asNumber.ok) expect(asNumber.monthlyDistance).toBe('200');

    const withUnit = parseCallbackBody({ ...valid, monthly_distance: '200km' });
    expect(withUnit.ok).toBe(true);
    if (withUnit.ok) expect(withUnit.monthlyDistance).toBe('200km');
  });

  test('rejects non-object bodies', () => {
    expect(parseCallbackBody(null).ok).toBe(false);
    expect(parseCallbackBody('x').ok).toBe(false);
    expect(parseCallbackBody([]).ok).toBe(false);
  });
});

describe('GET /api/consent-document', () => {
  test('returns the active document for a verified caller', async () => {
    installFetchStub({
      document: { id: 'doc-1', version: 'v1.0', title: '同意書', body_md: '# 本文' },
    });
    const app = buildApp();
    const res = await app.request(
      '/api/consent-document',
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
      ENV as any,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toEqual({ id: 'doc-1', version: 'v1.0', title: '同意書', body_md: '# 本文' });
  });

  test('401 when no Authorization header', async () => {
    installFetchStub({ document: null });
    const app = buildApp();
    const res = await app.request('/api/consent-document', {}, ENV as any);
    expect(res.status).toBe(401);
  });

  test('404 when no active document exists', async () => {
    installFetchStub({ document: null });
    const app = buildApp();
    const res = await app.request(
      '/api/consent-document',
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
      ENV as any,
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/consent-callback', () => {
  const body = {
    line_user_id: LINE_USER_ID,
    access_token: ACCESS_TOKEN,
    consent_document_version: 'v1.0 (2026-06-21)',
    confirmation_screen_shown_at: '2026-06-21T06:00:00.000Z',
    name: '田中 一郎',
    kana: 'たなか いちろう',
    phone: '08011112222',
    address: '東京都調布市1-1',
    email: 'taro@example.com',
    monthly_distance: '150',
  };

  function postReq(payload: unknown) {
    return new Request('http://local/api/consent-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  test('upserts consent and returns ok:true on a verified payload', async () => {
    installFetchStub({});
    const app = buildApp();
    const res = await app.request(postReq(body), undefined, ENV as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  test('403 when access_token resolves to a different line_user_id', async () => {
    installFetchStub({});
    const app = buildApp();
    const res = await app.request(
      postReq({ ...body, line_user_id: 'U_OTHER_USER' }),
      undefined,
      ENV as any,
    );
    expect(res.status).toBe(403);
  });

  test('401 when access_token verification fails', async () => {
    installFetchStub({ profileOk: false });
    const app = buildApp();
    const res = await app.request(postReq(body), undefined, ENV as any);
    expect(res.status).toBe(401);
  });

  test('400 when a required field is missing', async () => {
    installFetchStub({});
    const app = buildApp();
    const { phone, ...withoutPhone } = body;
    void phone;
    const res = await app.request(postReq(withoutPhone), undefined, ENV as any);
    expect(res.status).toBe(400);
  });

  test('400 when kana (required per Google Form) is missing', async () => {
    installFetchStub({});
    const app = buildApp();
    const { kana, ...withoutKana } = body;
    void kana;
    const res = await app.request(postReq(withoutKana), undefined, ENV as any);
    expect(res.status).toBe(400);
  });

  test('ok:true when optional fields are blank', async () => {
    installFetchStub({});
    const app = buildApp();
    const res = await app.request(
      postReq({ ...body, address: '', email: '', monthly_distance: '' }),
      undefined,
      ENV as any,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
