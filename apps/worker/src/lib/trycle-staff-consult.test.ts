import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildConsultEmailBody,
  notifyStaffConsult,
  isStaffConsultPostback,
  startStaffConsult,
  handleStaffConsultText,
  handleStaffConsultPostback,
  startStaffConsultFromPkg1,
} from './trycle-staff.js';
import type { Env } from '../index.js';
import type { LineClient } from '@line-crm/line-sdk';

type Bindings = Env['Bindings'];

function bindings(o: Partial<Bindings> = {}): Bindings {
  return {
    SUPABASE_URL: 'https://sb.example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
    TRYCLE_TENANT_ID: 't-1',
    GAS_WEB_APP_URL: 'https://script.example.com/exec',
    DASHBOARD_PUBLIC_URL: 'https://dash.example.com',
    ...o,
  } as Bindings;
}

/** replyMessage を記録する fake LineClient。 */
function fakeClient(): { client: LineClient; replies: unknown[][] } {
  const replies: unknown[][] = [];
  const client = {
    replyMessage: vi.fn(async (_token: string, messages: unknown[]) => {
      replies.push(messages);
    }),
  } as unknown as LineClient;
  return { client, replies };
}

function flatTexts(messages: unknown[]): string[] {
  const out: string[] = [];
  for (const m of messages as Array<{ type?: string; text?: string; altText?: string }>) {
    if (m.type === 'text' && m.text) out.push(m.text);
    if (m.type === 'flex' && m.altText) out.push(m.altText);
  }
  return out;
}

// ── isStaffConsultPostback ────────────────────────────────────────────────────

describe('isStaffConsultPostback', () => {
  it('matches the two confirm-loop postbacks only', () => {
    expect(isStaffConsultPostback('staff_consult_yes')).toBe(true);
    expect(isStaffConsultPostback('staff_consult_append')).toBe(true);
    expect(isStaffConsultPostback('faq_staff')).toBe(false);
    expect(isStaffConsultPostback('pkg1_start')).toBe(false);
  });
});

// ── buildConsultEmailBody (機密非含有 + case link) ─────────────────────────────

describe('buildConsultEmailBody', () => {
  const input = {
    lineUserId: 'Usecret123',
    customerName: '田中',
    inquiryContent: 'ブレーキの調整について相談したいです',
    source: 'pkg8' as const,
    reason: 'FAQ スタッフ相談',
  };

  it('includes customer name, reason, content, and dashboard link', () => {
    const body = buildConsultEmailBody(input, 'https://dash.example.com/cases/abc');
    expect(body).toContain('田中');
    expect(body).toContain('FAQ スタッフ相談');
    expect(body).toContain('ブレーキの調整');
    expect(body).toContain('https://dash.example.com/cases/abc');
  });

  it('never leaks the raw line_user_id', () => {
    const body = buildConsultEmailBody(input, null);
    expect(body).not.toContain('Usecret123');
  });

  it('omits the link line when no case url', () => {
    const body = buildConsultEmailBody(input, null);
    expect(body).not.toContain('dashboard で確認');
  });
});

// ── notifyStaffConsult (dual-fire) ────────────────────────────────────────────

describe('notifyStaffConsult', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  const input = {
    lineUserId: 'U1',
    customerName: '佐藤',
    inquiryContent: 'タイヤ交換について',
    source: 'pkg8' as const,
    reason: 'スタッフ相談',
  };

  it('marks case talking, writes a dashboard notification, and sends email', async () => {
    const calls: { url: string; method: string; body: string | null }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (i: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof i === 'string' ? i : i.toString();
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method, body: (init?.body as string) ?? null });
        if (url.includes('script.example.com')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.includes('/cases?') && method === 'GET') {
          return new Response(
            JSON.stringify([{ id: 'case-1', assignee_id: null, store_id: 's-1' }]),
            { status: 200 },
          );
        }
        if (url.includes('/case_statuses')) {
          return new Response(JSON.stringify([{ id: 'status-talking' }]), { status: 200 });
        }
        if (url.includes('/tenants')) {
          return new Response(JSON.stringify([{ settings: {} }]), { status: 200 });
        }
        if (url.includes('/users') && url.includes('role=eq.manager')) {
          return new Response(
            JSON.stringify([
              { id: 'u-mgr', email: 'm@x.com', display_name: 'M', role: 'manager', store_id: 's-1' },
            ]),
            { status: 200 },
          );
        }
        if (url.includes('/users') && url.includes('role=eq.owner')) {
          return new Response('[]', { status: 200 });
        }
        return new Response('[]', { status: 200 }); // cases PATCH, notifications POST, etc.
      },
    );

    const res = await notifyStaffConsult(bindings(), input);
    expect(res.ok).toBe(true);
    expect(res.caseMarked).toBe(true);
    expect(res.dashboardCount).toBe(1); // manager
    expect(res.emailCount).toBe(1); // manager email
    // notifications POST occurred
    expect(calls.some((c) => c.url.includes('/notifications') && c.method === 'POST')).toBe(true);
    // email POST to GAS occurred
    expect(calls.some((c) => c.url.includes('script.example.com'))).toBe(true);
  });

  it('still ok=true and writes dashboard even with no case (manager unassigned rule)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (i: RequestInfo | URL) => {
      const url = typeof i === 'string' ? i : i.toString();
      if (url.includes('/cases?')) return new Response('[]', { status: 200 }); // no case
      if (url.includes('/tenants')) return new Response(JSON.stringify([{ settings: {} }]), { status: 200 });
      if (url.includes('/users') && url.includes('role=eq.manager')) {
        return new Response(
          JSON.stringify([{ id: 'u-mgr', email: null, display_name: 'M', role: 'manager', store_id: null }]),
          { status: 200 },
        );
      }
      if (url.includes('script.example.com')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response('[]', { status: 200 });
    });

    const res = await notifyStaffConsult(bindings(), input);
    expect(res.ok).toBe(true);
    expect(res.caseMarked).toBe(false); // no case
    expect(res.dashboardCount).toBe(1); // manager dashboard row
    expect(res.emailCount).toBe(0); // manager has no email
  });
});

// ── B1 内容確認ループ (state machine) ─────────────────────────────────────────

describe('staff consult confirmation loop (B1)', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  /** bot_sessions を in-memory に持つ Supabase mock。kind 単位 1 行。 */
  function inMemorySupabase() {
    const store = new Map<string, Record<string, unknown>>(); // key=kind
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (i: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof i === 'string' ? i : i.toString();
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.includes('/bot_sessions')) {
          if (method === 'GET') {
            const kind = url.match(/kind=eq\.([^&]+)/)?.[1] ?? '';
            const row = store.get(decodeURIComponent(kind));
            return new Response(JSON.stringify(row ? [row] : []), { status: 200 });
          }
          if (method === 'POST') {
            const rows = JSON.parse((init!.body as string) ?? '[]') as Record<string, unknown>[];
            for (const r of rows) store.set(String(r.kind), r);
            return new Response('[]', { status: 201 });
          }
          if (method === 'DELETE') {
            const kind = url.match(/kind=eq\.([^&]+)/)?.[1] ?? '';
            store.delete(decodeURIComponent(kind));
            return new Response('[]', { status: 200 });
          }
        }
        // notifyStaffConsult downstream (finalize): no case, no tenant settings.
        if (url.includes('/tenants')) return new Response(JSON.stringify([{ settings: {} }]), { status: 200 });
        return new Response('[]', { status: 200 });
      },
    );
    return store;
  }

  it('startStaffConsult with no seed prompts for input', async () => {
    inMemorySupabase();
    const { client, replies } = fakeClient();
    await startStaffConsult(
      { replyToken: 'r', lineUserId: 'U1', lineClient: client, env: bindings() },
      { source: 'pkg8', reason: 'FAQ スタッフ相談' },
    );
    expect(flatTexts(replies[0]!).join()).toContain('入力してください');
  });

  it('startStaffConsult with seed jumps straight to confirm bubble', async () => {
    inMemorySupabase();
    const { client, replies } = fakeClient();
    await startStaffConsultFromPkg1(
      { replyToken: 'r', lineUserId: 'U1', lineClient: client, env: bindings() },
      'カーボンフレームの相談',
      'お悩み相談',
    );
    expect(flatTexts(replies[0]!).join()).toContain('連携');
  });

  it('text input transitions input → confirm', async () => {
    inMemorySupabase();
    const { client, replies } = fakeClient();
    const ctx = { replyToken: 'r', lineUserId: 'U1', lineClient: client, env: bindings() };
    await startStaffConsult(ctx, { source: 'pkg8', reason: 'FAQ スタッフ相談' });
    const handled = await handleStaffConsultText(ctx, 'ブレーキが効きません');
    expect(handled).toBe(true);
    expect(flatTexts(replies[1]!).join()).toContain('連携'); // confirm bubble
  });

  it('text input returns false when no active loop', async () => {
    inMemorySupabase();
    const { client } = fakeClient();
    const ctx = { replyToken: 'r', lineUserId: 'U1', lineClient: client, env: bindings() };
    const handled = await handleStaffConsultText(ctx, 'こんにちは');
    expect(handled).toBe(false);
  });

  it('append re-prompts for input and increments count (within limit)', async () => {
    inMemorySupabase();
    const { client, replies } = fakeClient();
    const ctx = { replyToken: 'r', lineUserId: 'U1', lineClient: client, env: bindings() };
    await startStaffConsultFromPkg1(ctx, '最初の相談', 'お悩み相談'); // → confirm
    await handleStaffConsultPostback(ctx, 'staff_consult_append'); // count 0→1, awaiting input
    expect(flatTexts(replies[1]!).join()).toContain('追加で書きたい');
    await handleStaffConsultText(ctx, '追加の内容'); // → confirm (merged)
    expect(flatTexts(replies[2]!).join()).toContain('連携');
  });

  it('yes finalizes: sends, sets manual mode, clears session', async () => {
    const store = inMemorySupabase();
    const { client, replies } = fakeClient();
    const ctx = { replyToken: 'r', lineUserId: 'U1', lineClient: client, env: bindings() };
    await startStaffConsultFromPkg1(ctx, 'タイヤ交換の相談', 'お悩み相談'); // → confirm
    await handleStaffConsultPostback(ctx, 'staff_consult_yes'); // finalize
    const last = flatTexts(replies[replies.length - 1]!).join();
    expect(last).toContain('送信しました');
    // manual_mode set, staff_consult cleared
    expect(store.has('manual_mode')).toBe(true);
    expect(store.has('staff_consult')).toBe(false);
  });

  it('append beyond limit auto-finalizes', async () => {
    const store = inMemorySupabase();
    const { client, replies } = fakeClient();
    const ctx = { replyToken: 'r', lineUserId: 'U1', lineClient: client, env: bindings() };
    await startStaffConsultFromPkg1(ctx, 'a', 'お悩み相談'); // confirm
    await handleStaffConsultPostback(ctx, 'staff_consult_append'); // 0→1 input
    await handleStaffConsultText(ctx, 'b'); // confirm
    await handleStaffConsultPostback(ctx, 'staff_consult_append'); // 1→2 input
    await handleStaffConsultText(ctx, 'c'); // confirm
    await handleStaffConsultPostback(ctx, 'staff_consult_append'); // at limit → auto finalize
    const last = flatTexts(replies[replies.length - 1]!).join();
    expect(last).toContain('送信しました');
    expect(store.has('staff_consult')).toBe(false);
  });

  it('postback with no session gives graceful re-prompt', async () => {
    inMemorySupabase();
    const { client, replies } = fakeClient();
    const ctx = { replyToken: 'r', lineUserId: 'U1', lineClient: client, env: bindings() };
    const handled = await handleStaffConsultPostback(ctx, 'staff_consult_yes');
    expect(handled).toBe(true);
    expect(flatTexts(replies[0]!).join()).toContain('もう一度');
  });
});
