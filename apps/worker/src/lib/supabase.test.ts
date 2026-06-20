import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getSupabaseConfig,
  supabaseSelect,
  supabaseUpsert,
  supabaseUpdate,
  supabaseDelete,
  type SupabaseEnvLike,
} from './supabase.js';

const env: SupabaseEnvLike = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
};

const originalFetch = globalThis.fetch;

describe('getSupabaseConfig', () => {
  it('returns config when both env vars are set', () => {
    const config = getSupabaseConfig(env);
    expect(config.url).toBe('https://example.supabase.co');
    expect(config.serviceRoleKey).toBe('service-role-key');
  });

  it('throws when SUPABASE_URL is missing', () => {
    expect(() => getSupabaseConfig({ SUPABASE_SERVICE_ROLE_KEY: 'x' })).toThrow(
      /SUPABASE_URL/,
    );
  });

  it('throws when service-role key is missing', () => {
    expect(() => getSupabaseConfig({ SUPABASE_URL: 'https://x' })).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
  });
});

describe('supabaseSelect', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('builds URL with filter + select + limit and returns rows', async () => {
    const mockRows = [{ id: 'a', name: 'foo' }];
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => mockRows,
    });
    const result = await supabaseSelect<{ id: string; name: string }>(
      env,
      'customers',
      { tenant_id: 'eq.t1', name: 'eq.foo' },
      { select: 'id,name', limit: 5 },
    );
    expect(result).toEqual(mockRows);
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const calledUrl = fetchCall[0] as string;
    expect(calledUrl).toContain('/rest/v1/customers');
    expect(calledUrl).toContain('select=id%2Cname');
    expect(calledUrl).toContain('tenant_id=eq.t1');
    expect(calledUrl).toContain('name=eq.foo');
    expect(calledUrl).toContain('limit=5');
    const headers = fetchCall[1].headers as Record<string, string>;
    expect(headers.apikey).toBe('service-role-key');
    expect(headers.Authorization).toBe('Bearer service-role-key');
  });

  it('throws on non-OK response', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"message":"unauth"}',
    });
    await expect(
      supabaseSelect(env, 'customers', { tenant_id: 'eq.t1' }),
    ).rejects.toThrow(/401/);
  });
});

describe('supabaseUpsert', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends rows with merge-duplicates Prefer header and returns null for minimal', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
    });
    const result = await supabaseUpsert(
      env,
      'consents',
      [
        {
          tenant_id: 't1',
          line_user_id: 'U1',
          source: 'maintenance-consent',
        },
      ],
      { onConflict: 'tenant_id,line_user_id,source' },
    );
    expect(result).toBeNull();
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toContain('on_conflict=tenant_id%2Cline_user_id%2Csource');
    const headers = fetchCall[1].headers as Record<string, string>;
    expect(headers.Prefer).toContain('resolution=merge-duplicates');
    expect(headers.Prefer).toContain('return=minimal');
  });

  it('returns rows when return=representation requested', async () => {
    const mockRows = [{ id: 'a' }];
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => mockRows,
    });
    const result = await supabaseUpsert<{ id: string }>(
      env,
      'customers',
      [{ tenant_id: 't1', name: 'x' }],
      { returning: 'representation' },
    );
    expect(result).toEqual(mockRows);
  });
});

describe('supabaseUpdate', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('PATCHes with filter and patch body', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    await supabaseUpdate(
      env,
      'customers',
      { tenant_id: 'eq.t1', id: 'eq.c1' },
      { name: 'updated' },
    );
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].method).toBe('PATCH');
    expect(JSON.parse(fetchCall[1].body)).toEqual({ name: 'updated' });
    expect(fetchCall[0]).toContain('tenant_id=eq.t1');
    expect(fetchCall[0]).toContain('id=eq.c1');
  });
});

describe('supabaseDelete', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('refuses delete without filter', async () => {
    await expect(supabaseDelete(env, 'customers', {})).rejects.toThrow(
      /at least one filter/,
    );
  });

  it('DELETEs with filter', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    await supabaseDelete(env, 'bot_sessions', {
      tenant_id: 'eq.t1',
      line_user_id: 'eq.U1',
    });
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].method).toBe('DELETE');
    expect(fetchCall[0]).toContain('tenant_id=eq.t1');
    expect(fetchCall[0]).toContain('line_user_id=eq.U1');
  });
});
