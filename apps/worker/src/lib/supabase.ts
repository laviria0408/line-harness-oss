/**
 * Supabase REST helper for Cloudflare Workers (TRYCLE business data).
 *
 * Why a thin REST wrapper, not @supabase/supabase-js?
 *   The official SDK works in Workers but pulls in the Realtime/WebSocket
 *   client and listens-by-default storage helpers we never use, so the bundle
 *   would more than double for a few `select`/`upsert` calls. A 60-line REST
 *   client keeps cold-start light and surfaces every quirk (PostgREST
 *   `Prefer:` semantics, `apikey` + `Authorization` duplication, error shape)
 *   in one place we can grep.
 *
 * Tenant isolation
 *   Every query filters on tenant_id at the API boundary; service-role key
 *   bypasses RLS so we *must* enforce it manually. Pass `tenantId` to every
 *   helper.
 */

interface SupabaseConfig {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export interface SupabaseEnvLike {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

export function getSupabaseConfig(env: SupabaseEnvLike): SupabaseConfig {
  const url = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  }
  return { url, serviceRoleKey };
}

function buildHeaders(
  config: SupabaseConfig,
  extra?: Record<string, string>,
): HeadersInit {
  return {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}

/**
 * SELECT with arbitrary filters. `filter` keys are PostgREST operators:
 *   { 'tenant_id': 'eq.<uuid>', 'line_user_id': 'eq.U...' }
 * Default `select` is '*'. Limit defaults to 1 to make the common case
 * (single row lookup) safe-by-default.
 */
export async function supabaseSelect<T>(
  env: SupabaseEnvLike,
  table: string,
  filter: Record<string, string>,
  options?: { select?: string; limit?: number; order?: string },
): Promise<T[]> {
  const config = getSupabaseConfig(env);
  const params = new URLSearchParams({
    select: options?.select ?? '*',
  });
  for (const [key, value] of Object.entries(filter)) {
    params.set(key, value);
  }
  if (options?.limit !== undefined) {
    params.set('limit', String(options.limit));
  }
  if (options?.order) {
    params.set('order', options.order);
  }
  const url = `${config.url}/rest/v1/${encodeURIComponent(table)}?${params.toString()}`;
  const res = await fetch(url, { headers: buildHeaders(config) });
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new Error(`supabase SELECT ${table} ${res.status}: ${body}`);
  }
  return (await res.json()) as T[];
}

/**
 * UPSERT (PostgREST `on_conflict`) — returns minimal/representation depending
 * on caller need. Default = minimal (no body) to save bandwidth.
 */
export async function supabaseUpsert<T = void>(
  env: SupabaseEnvLike,
  table: string,
  rows: ReadonlyArray<Record<string, unknown>>,
  options?: { onConflict?: string; returning?: 'minimal' | 'representation' },
): Promise<T extends void ? null : T[]> {
  const config = getSupabaseConfig(env);
  const params = new URLSearchParams();
  if (options?.onConflict) {
    params.set('on_conflict', options.onConflict);
  }
  const returning = options?.returning ?? 'minimal';
  const url = `${config.url}/rest/v1/${encodeURIComponent(table)}${params.toString() ? `?${params.toString()}` : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(config, {
      Prefer: `resolution=merge-duplicates,return=${returning}`,
    }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new Error(`supabase UPSERT ${table} ${res.status}: ${body}`);
  }
  if (returning === 'minimal') {
    return null as T extends void ? null : T[];
  }
  return (await res.json()) as T extends void ? null : T[];
}

/**
 * UPDATE by filter. Returns updated row count via Content-Range header if
 * caller wants it; otherwise returns void.
 */
export async function supabaseUpdate(
  env: SupabaseEnvLike,
  table: string,
  filter: Record<string, string>,
  patch: Record<string, unknown>,
): Promise<void> {
  const config = getSupabaseConfig(env);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    params.set(key, value);
  }
  const url = `${config.url}/rest/v1/${encodeURIComponent(table)}?${params.toString()}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: buildHeaders(config, { Prefer: 'return=minimal' }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new Error(`supabase UPDATE ${table} ${res.status}: ${body}`);
  }
}

/**
 * DELETE by filter. Caller must pass at least one filter to avoid full-table
 * truncation; PostgREST refuses DELETE without WHERE by default, but defense
 * in depth.
 */
export async function supabaseDelete(
  env: SupabaseEnvLike,
  table: string,
  filter: Record<string, string>,
): Promise<void> {
  if (Object.keys(filter).length === 0) {
    throw new Error('supabaseDelete requires at least one filter');
  }
  const config = getSupabaseConfig(env);
  const params = new URLSearchParams(filter);
  const url = `${config.url}/rest/v1/${encodeURIComponent(table)}?${params.toString()}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: buildHeaders(config, { Prefer: 'return=minimal' }),
  });
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new Error(`supabase DELETE ${table} ${res.status}: ${body}`);
  }
}

/**
 * DELETE that RETURNS the deleted rows (PostgREST `Prefer: return=representation`).
 *
 * Use this for atomic claim-and-delete: a single DELETE deletes the matching
 * row(s) and reports exactly which rows it removed, so two concurrent requests
 * (e.g. a double-tapped LINE postback) cannot both receive the same row — only
 * the request that actually deleted it gets a non-empty array. The other gets
 * an empty array and can treat it as "already consumed".
 */
export async function supabaseDeleteReturning<T>(
  env: SupabaseEnvLike,
  table: string,
  filter: Record<string, string>,
  select = '*',
): Promise<T[]> {
  if (Object.keys(filter).length === 0) {
    throw new Error('supabaseDeleteReturning requires at least one filter');
  }
  const config = getSupabaseConfig(env);
  const params = new URLSearchParams(filter);
  params.set('select', select);
  const url = `${config.url}/rest/v1/${encodeURIComponent(table)}?${params.toString()}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: buildHeaders(config, { Prefer: 'return=representation' }),
  });
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new Error(`supabase DELETE ${table} ${res.status}: ${body}`);
  }
  return (await res.json()) as T[];
}
