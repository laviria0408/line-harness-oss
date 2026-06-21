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

/** tenant スコープで line_user_id から customer_id を取得 (upsertCustomer の後で紐付け用)。 */
export async function findCustomerIdByLineUserId(
  env: TrycleRepoEnv,
  lineUserId: string,
): Promise<string | null> {
  const rows = await supabaseSelect<{ id: string }>(
    env,
    'customers',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      line_user_id: `eq.${lineUserId}`,
    },
    { select: 'id', limit: 1 },
  );
  return rows[0]?.id ?? null;
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

// ── Consent document (Pkg1 LIFF 案 B) ────────────────────────────────────────
//
// 同意書文面の version 管理マスタ。LIFF 同意書 (apps/consent-liff/) の Step 1 が
// 最新の有効版を取得して body_md を render する。設計: Notion consent_documents
// 設計書 v1.0 (386050ad6a7e81a9a388c11d68355bfd)。

export interface ConsentDocumentRow {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly body_md: string;
}

/**
 * 最新の有効な同意書文面 (archived=false を valid_from desc で先頭 1 件) を返す。
 * 文面が未投入なら null。
 */
export async function findActiveConsentDocument(
  env: TrycleRepoEnv,
): Promise<ConsentDocumentRow | null> {
  const rows = await supabaseSelect<ConsentDocumentRow>(
    env,
    'consent_documents',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      archived: 'eq.false',
    },
    {
      select: 'id,version,title,body_md',
      order: 'valid_from.desc',
      limit: 1,
    },
  );
  return rows[0] ?? null;
}

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
    customerId?: string | null;
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
        customer_id: patch.customerId ?? null,
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
