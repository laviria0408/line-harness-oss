/**
 * TRYCLE Supabase repo (Phase B-3). All queries are tenant-scoped — the
 * service-role key bypasses RLS so we enforce `tenant_id` in every helper.
 */
import { supabaseSelect, supabaseUpsert, type SupabaseEnvLike } from './supabase.js';

export interface TrycleRepoEnv extends SupabaseEnvLike {
  TRYCLE_TENANT_ID?: string;
}

export function getTenantId(env: TrycleRepoEnv): string {
  if (!env.TRYCLE_TENANT_ID) {
    throw new Error('TRYCLE_TENANT_ID not configured');
  }
  return env.TRYCLE_TENANT_ID;
}

// ── Customer ────────────────────────────────────────────────────────────────

export interface CustomerRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly line_user_id: string | null;
}

export async function findCustomerByLineUserId(
  env: TrycleRepoEnv,
  lineUserId: string,
): Promise<CustomerRow | null> {
  const rows = await supabaseSelect<CustomerRow>(
    env,
    'customers',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      line_user_id: `eq.${lineUserId}`,
    },
    { limit: 1 },
  );
  return rows[0] ?? null;
}

export async function upsertCustomer(
  env: TrycleRepoEnv,
  patch: {
    lineUserId: string;
    name: string;
    phone?: string | null;
    email?: string | null;
  },
): Promise<void> {
  await supabaseUpsert(
    env,
    'customers',
    [
      {
        tenant_id: getTenantId(env),
        line_user_id: patch.lineUserId,
        name: patch.name,
        phone: patch.phone ?? null,
        email: patch.email ?? null,
        updated_at: new Date().toISOString(),
      },
    ],
    { onConflict: 'tenant_id,line_user_id' },
  );
}

// ── Consent (maintenance-consent etc.) ──────────────────────────────────────

export interface ConsentRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly line_user_id: string;
  readonly source: string;
  readonly consented_at: string;
}

export const MAINTENANCE_CONSENT_SOURCE = 'maintenance-consent';
export const CONSENT_VALIDITY_DAYS = 365;

export async function hasValidMaintenanceConsent(
  env: TrycleRepoEnv,
  lineUserId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await supabaseSelect<{ consented_at: string }>(
    env,
    'consents',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      line_user_id: `eq.${lineUserId}`,
      source: `eq.${MAINTENANCE_CONSENT_SOURCE}`,
    },
    { select: 'consented_at', limit: 1 },
  );
  if (rows.length === 0) {
    return false;
  }
  const consentedAt = new Date(rows[0].consented_at);
  const expiresAtMs =
    consentedAt.getTime() + CONSENT_VALIDITY_DAYS * 24 * 3600 * 1000;
  return expiresAtMs > now.getTime();
}

export async function upsertConsent(
  env: TrycleRepoEnv,
  patch: {
    lineUserId: string;
    source: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await supabaseUpsert(
    env,
    'consents',
    [
      {
        tenant_id: getTenantId(env),
        line_user_id: patch.lineUserId,
        source: patch.source,
        consented_at: new Date().toISOString(),
        payload: patch.payload ?? {},
        updated_at: new Date().toISOString(),
      },
    ],
    { onConflict: 'tenant_id,line_user_id,source' },
  );
}

// ── Store ───────────────────────────────────────────────────────────────────

export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

export interface StoreRow {
  readonly id: string;
  readonly name: string;
  readonly code: string | null;
  readonly business_hours: Partial<Record<Weekday, [string, string] | []>>;
  readonly reservation_slot_minutes: number;
  readonly is_active: boolean;
}

export async function listActiveStores(env: TrycleRepoEnv): Promise<StoreRow[]> {
  return supabaseSelect<StoreRow>(
    env,
    'stores',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      is_active: 'eq.true',
    },
    {
      select: 'id,name,code,business_hours,reservation_slot_minutes,is_active',
      order: 'sort_order.asc',
    },
  );
}

export async function findStoreById(
  env: TrycleRepoEnv,
  storeId: string,
): Promise<StoreRow | null> {
  const rows = await supabaseSelect<StoreRow>(
    env,
    'stores',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      id: `eq.${storeId}`,
    },
    { limit: 1 },
  );
  return rows[0] ?? null;
}

// ── Labor master ────────────────────────────────────────────────────────────

export interface LaborOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly price: number;
  readonly is_default: boolean;
  readonly sort_order: number;
  readonly notes: string | null;
}

export interface LaborEntry {
  readonly id: string;
  readonly code: string;
  readonly category: string;
  readonly name: string;
  readonly price: number;
  readonly price_open_ended: boolean;
  readonly duration_days: number | null;
  readonly notes: string | null;
  readonly applicable_to: string[];
  readonly sort_order: number;
}

export async function findLaborByCode(
  env: TrycleRepoEnv,
  code: string,
): Promise<LaborEntry | null> {
  const rows = await supabaseSelect<LaborEntry>(
    env,
    'labor_master',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      code: `eq.${code}`,
      archived: 'eq.false',
    },
    { limit: 1 },
  );
  return rows[0] ?? null;
}
