import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mergeCaseStaffConsult,
  getCaseStaffConsultRules,
  resolveTarget,
  resolveCaseStaffConsult,
  DEFAULT_CASE_STAFF_CONSULT_RULES,
} from './trycle-notify-rules.js';
import type { TrycleRepoEnv } from './trycle-repo.js';

function env(): TrycleRepoEnv {
  return {
    SUPABASE_URL: 'https://sb.example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
    TRYCLE_TENANT_ID: 't-1',
  } as TrycleRepoEnv;
}

/**
 * URL ベースで Supabase REST を mock する。table 名 (URL path) ごとに JSON を返す。
 * map のキーは table 名・値は返す行配列。
 */
function mockSupabase(byTable: Record<string, unknown[]>): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const table = url.match(/\/rest\/v1\/([^?]+)/)?.[1] ?? '';
    const rows = byTable[table] ?? [];
    return new Response(JSON.stringify(rows), { status: 200 });
  });
}

// ── sanitize / merge (dashboard mergeCaseStaffConsult と同形) ──────────────────

describe('mergeCaseStaffConsult', () => {
  it('returns defaults for empty / non-object input', () => {
    expect(mergeCaseStaffConsult(undefined)).toEqual(DEFAULT_CASE_STAFF_CONSULT_RULES);
    expect(mergeCaseStaffConsult(null)).toEqual(DEFAULT_CASE_STAFF_CONSULT_RULES);
    expect(mergeCaseStaffConsult('nope')).toEqual(DEFAULT_CASE_STAFF_CONSULT_RULES);
  });

  it('keeps valid targets and channels, drops unknown', () => {
    const merged = mergeCaseStaffConsult({
      assigned: { to: 'assignee', via: ['email', 'bogus', 'dashboard'] },
      unassigned: { to: 'all', via: ['web_push'] },
      owner: { to: { user_id: 'u-9' }, via: ['dashboard'] },
    });
    // unknown channel "bogus" dropped, order normalized to canonical
    expect(merged.assigned).toEqual({ to: 'assignee', via: ['dashboard', 'email'] });
    expect(merged.unassigned).toEqual({ to: 'all', via: ['web_push'] });
    expect(merged.owner).toEqual({ to: { user_id: 'u-9' }, via: ['dashboard'] });
  });

  it('falls back to default channels when via is empty / invalid', () => {
    const merged = mergeCaseStaffConsult({ assigned: { to: 'assignee', via: [] } });
    expect(merged.assigned.via).toEqual(DEFAULT_CASE_STAFF_CONSULT_RULES.assigned.via);
  });

  it('rejects empty user_id object, falls back to default target', () => {
    const merged = mergeCaseStaffConsult({ assigned: { to: { user_id: '' }, via: ['email'] } });
    expect(merged.assigned.to).toBe(DEFAULT_CASE_STAFF_CONSULT_RULES.assigned.to);
  });
});

// ── getCaseStaffConsultRules ──────────────────────────────────────────────────

describe('getCaseStaffConsultRules', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('returns default when tenant settings have no caseStaffConsult', async () => {
    mockSupabase({ tenants: [{ settings: { notifyRules: {} } }] });
    const rules = await getCaseStaffConsultRules(env());
    expect(rules).toEqual(DEFAULT_CASE_STAFF_CONSULT_RULES);
  });

  it('returns merged rules from tenant settings', async () => {
    mockSupabase({
      tenants: [
        {
          settings: {
            notifyRules: {
              caseStaffConsult: {
                assigned: { to: 'manager', via: ['dashboard'] },
                unassigned: { to: 'all', via: ['email'] },
                owner: { to: 'owner', via: ['dashboard'] },
              },
            },
          },
        },
      ],
    });
    const rules = await getCaseStaffConsultRules(env());
    expect(rules.assigned).toEqual({ to: 'manager', via: ['dashboard'] });
    expect(rules.unassigned).toEqual({ to: 'all', via: ['email'] });
  });

  it('returns default (fail-safe) on Supabase error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const rules = await getCaseStaffConsultRules(env());
    expect(rules).toEqual(DEFAULT_CASE_STAFF_CONSULT_RULES);
  });
});

// ── resolveTarget ─────────────────────────────────────────────────────────────

describe('resolveTarget', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  const caseRef = { assigneeId: 'u-assignee', storeId: 's-1' };

  it('assignee → the case assignee user', async () => {
    mockSupabase({
      users: [{ id: 'u-assignee', email: 'a@x.com', display_name: 'A', role: 'staff', store_id: 's-1' }],
    });
    const got = await resolveTarget(env(), 'assignee', caseRef);
    expect(got).toHaveLength(1);
    expect(got[0]!.userId).toBe('u-assignee');
    expect(got[0]!.email).toBe('a@x.com');
  });

  it('assignee → empty when case has no assignee', async () => {
    mockSupabase({ users: [] });
    const got = await resolveTarget(env(), 'assignee', { assigneeId: null, storeId: 's-1' });
    expect(got).toEqual([]);
  });

  it('manager → users with role=manager (store-scoped)', async () => {
    mockSupabase({
      users: [{ id: 'u-mgr', email: 'm@x.com', display_name: 'M', role: 'manager', store_id: 's-1' }],
    });
    const got = await resolveTarget(env(), 'manager', caseRef);
    expect(got.map((r) => r.userId)).toEqual(['u-mgr']);
  });

  it('all → a single global recipient (userId null)', async () => {
    mockSupabase({});
    const got = await resolveTarget(env(), 'all', caseRef);
    expect(got).toEqual([{ userId: null, email: null, displayName: null }]);
  });

  it('all_owners → every owner', async () => {
    mockSupabase({
      users: [
        { id: 'o-1', email: 'o1@x.com', display_name: 'O1', role: 'owner', store_id: null },
        { id: 'o-2', email: null, display_name: 'O2', role: 'owner', store_id: null },
      ],
    });
    const got = await resolveTarget(env(), 'all_owners', caseRef);
    expect(got.map((r) => r.userId)).toEqual(['o-1', 'o-2']);
  });

  it('{ user_id } → that user', async () => {
    mockSupabase({
      users: [{ id: 'u-9', email: 'nine@x.com', display_name: 'Nine', role: 'staff', store_id: null }],
    });
    const got = await resolveTarget(env(), { user_id: 'u-9' }, caseRef);
    expect(got[0]!.userId).toBe('u-9');
  });
});

// ── resolveCaseStaffConsult (dual-fire の宛先解決) ─────────────────────────────

describe('resolveCaseStaffConsult', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('unassigned case → manager (dashboard+email) + owner (dashboard) by default', async () => {
    // default: unassigned → manager via [dashboard,email]; owner → all_owners via [dashboard]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/tenants')) {
        return new Response(JSON.stringify([{ settings: {} }]), { status: 200 });
      }
      if (url.includes('/users')) {
        if (url.includes('role=eq.manager')) {
          return new Response(
            JSON.stringify([
              { id: 'u-mgr', email: 'm@x.com', display_name: 'M', role: 'manager', store_id: 's-1' },
            ]),
            { status: 200 },
          );
        }
        if (url.includes('role=eq.owner')) {
          return new Response(
            JSON.stringify([
              { id: 'o-1', email: 'o1@x.com', display_name: 'O1', role: 'owner', store_id: null },
            ]),
            { status: 200 },
          );
        }
      }
      return new Response('[]', { status: 200 });
    });

    const res = await resolveCaseStaffConsult(env(), { assigneeId: null, storeId: 's-1' });
    expect(res.state).toBe('unassigned');
    // dashboard: manager + owner
    expect(res.dashboardRecipients.map((r) => r.userId).sort()).toEqual(['o-1', 'u-mgr']);
    // email: only manager (owner default via is dashboard-only)
    expect(res.emailRecipients.map((r) => r.email)).toEqual(['m@x.com']);
  });

  it('assigned case → assignee branch (state=assigned)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/tenants')) {
        return new Response(JSON.stringify([{ settings: {} }]), { status: 200 });
      }
      if (url.includes('/users')) {
        if (url.includes('id=eq.u-assignee')) {
          return new Response(
            JSON.stringify([
              { id: 'u-assignee', email: 'a@x.com', display_name: 'A', role: 'staff', store_id: 's-1' },
            ]),
            { status: 200 },
          );
        }
        if (url.includes('role=eq.owner')) {
          return new Response('[]', { status: 200 });
        }
      }
      return new Response('[]', { status: 200 });
    });

    const res = await resolveCaseStaffConsult(env(), { assigneeId: 'u-assignee', storeId: 's-1' });
    expect(res.state).toBe('assigned');
    expect(res.dashboardRecipients.map((r) => r.userId)).toContain('u-assignee');
    expect(res.emailRecipients.map((r) => r.email)).toContain('a@x.com');
  });
});
