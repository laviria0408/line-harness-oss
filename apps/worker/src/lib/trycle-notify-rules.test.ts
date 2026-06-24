import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_CASE_STAFF_CONSULT_RULES,
  mergeCaseStaffConsult,
  resolveCaseStaffConsult,
} from './trycle-notify-rules.js';
import type { TrycleRepoEnv } from './trycle-repo.js';

function env(): TrycleRepoEnv {
  return {
    SUPABASE_URL: 'https://supabase.example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'srv-key',
    TRYCLE_TENANT_ID: 'tenant-1',
  } as unknown as TrycleRepoEnv;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('trycle-notify-rules (user 仕様 2026-06-25 表形式)', () => {
  it('DEFAULT が表通り (未割当=owner+manager / 割当済=owner+manager+staff)', () => {
    expect(DEFAULT_CASE_STAFF_CONSULT_RULES.unassigned.toRoles).toEqual(['owner', 'manager']);
    expect(DEFAULT_CASE_STAFF_CONSULT_RULES.assigned.toRoles).toEqual(['owner', 'manager', 'staff']);
  });

  it('mergeCaseStaffConsult: 空入力は default', () => {
    const merged = mergeCaseStaffConsult({});
    expect(merged.unassigned.toRoles).toEqual(['owner', 'manager']);
    expect(merged.assigned.toRoles).toEqual(['owner', 'manager', 'staff']);
  });

  it('mergeCaseStaffConsult: toRoles に未知 role が含まれていても filter', () => {
    const merged = mergeCaseStaffConsult({
      unassigned: { toRoles: ['owner', 'bogus', 'manager'], via: ['dashboard'] },
    });
    expect(merged.unassigned.toRoles).toEqual(['owner', 'manager']);
    expect(merged.unassigned.via).toEqual(['dashboard']);
  });

  it('mergeCaseStaffConsult: toRoles が空 array なら default 復帰', () => {
    const merged = mergeCaseStaffConsult({
      assigned: { toRoles: [], via: ['email'] },
    });
    expect(merged.assigned.toRoles).toEqual(['owner', 'manager', 'staff']);
  });
});

describe('resolveCaseStaffConsult (new toRoles 配列)', () => {
  it('unassigned: default で owner + manager 全員に通知 + superadmin 加算', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/tenants')) {
        return new Response(JSON.stringify([{ settings: {} }]), { status: 200 });
      }
      if (url.includes('/users')) {
        if (url.includes('role=eq.manager')) {
          return new Response(
            JSON.stringify([{ id: 'u-mgr', email: 'm@x.com', display_name: 'M', role: 'manager', store_id: 's-1' }]),
            { status: 200 },
          );
        }
        if (url.includes('role=eq.owner')) {
          return new Response(
            JSON.stringify([{ id: 'u-own', email: 'o@x.com', display_name: 'O', role: 'owner', store_id: null }]),
            { status: 200 },
          );
        }
        if (url.includes('role=eq.staff')) {
          return new Response('[]', { status: 200 });
        }
        if (url.includes('role=eq.superadmin')) {
          return new Response(
            JSON.stringify([{ id: 'u-sa', email: 'sa@x.com', display_name: '本部', role: 'superadmin', store_id: null }]),
            { status: 200 },
          );
        }
      }
      return new Response('[]', { status: 200 });
    });

    const res = await resolveCaseStaffConsult(env(), { assigneeId: null, storeId: 's-1' });
    expect(res.state).toBe('unassigned');
    const ids = res.dashboardRecipients.map((r) => r.userId).sort();
    expect(ids).toEqual(['u-mgr', 'u-own', 'u-sa']);
    expect(res.emailRecipients.map((r) => r.email).sort()).toEqual(['m@x.com', 'o@x.com']);
  });

  it('assigned: default で owner + manager + staff 全員 + superadmin 加算', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/tenants')) {
        return new Response(JSON.stringify([{ settings: {} }]), { status: 200 });
      }
      if (url.includes('/users')) {
        if (url.includes('role=eq.manager')) {
          return new Response(
            JSON.stringify([{ id: 'u-mgr', email: 'm@x.com', display_name: 'M', role: 'manager', store_id: 's-1' }]),
            { status: 200 },
          );
        }
        if (url.includes('role=eq.owner')) {
          return new Response(
            JSON.stringify([{ id: 'u-own', email: null, display_name: 'O', role: 'owner', store_id: null }]),
            { status: 200 },
          );
        }
        if (url.includes('role=eq.staff')) {
          return new Response(
            JSON.stringify([{ id: 'u-staff', email: 's@x.com', display_name: 'S', role: 'staff', store_id: 's-1' }]),
            { status: 200 },
          );
        }
        if (url.includes('role=eq.superadmin')) {
          return new Response('[]', { status: 200 });
        }
      }
      return new Response('[]', { status: 200 });
    });

    const res = await resolveCaseStaffConsult(env(), { assigneeId: 'u-staff', storeId: 's-1' });
    expect(res.state).toBe('assigned');
    const ids = res.dashboardRecipients.map((r) => r.userId).sort();
    expect(ids).toEqual(['u-mgr', 'u-own', 'u-staff']);
    // owner は email なしなので email recipients に含まれない
    expect(res.emailRecipients.map((r) => r.email).sort()).toEqual(['m@x.com', 's@x.com']);
  });

  it('rules.via が ["dashboard"] のみなら email 0 件', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/tenants')) {
        return new Response(
          JSON.stringify([
            {
              settings: {
                notifyRules: {
                  caseStaffConsult: {
                    unassigned: { toRoles: ['manager'], via: ['dashboard'] },
                    assigned: { toRoles: ['owner'], via: ['dashboard'] },
                  },
                },
              },
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('/users') && url.includes('role=eq.manager')) {
        return new Response(
          JSON.stringify([{ id: 'u-mgr', email: 'm@x.com', display_name: 'M', role: 'manager', store_id: null }]),
          { status: 200 },
        );
      }
      return new Response('[]', { status: 200 });
    });

    const res = await resolveCaseStaffConsult(env(), { assigneeId: null, storeId: null });
    expect(res.dashboardRecipients.map((r) => r.userId)).toContain('u-mgr');
    expect(res.emailRecipients).toHaveLength(0);
  });
});
