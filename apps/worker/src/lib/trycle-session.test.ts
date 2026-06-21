import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isManualMode,
  cartSubtotal,
  emptyPkg1State,
  getPkg1Session,
  SESSION_STALE_MS,
} from './trycle-session.js';
import type { TrycleRepoEnv } from './trycle-repo.js';
import type { CartItem } from './trycle-session.js';

type Env = TrycleRepoEnv;

function env(): Env {
  return {
    SUPABASE_URL: 'https://sb.example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
    TRYCLE_TENANT_ID: 't-1',
  } as Env;
}

function item(p: Partial<CartItem> = {}): CartItem {
  return {
    labor_id: 'l', code: 'c', name: 'n', unit_price: 1000, unit_price_max: null,
    qty: 1, option_ids: [], option_names: [], option_total: 0, ...p,
  };
}

describe('emptyPkg1State', () => {
  it('starts at category_select with an empty cart', () => {
    const s = emptyPkg1State();
    expect(s.step).toBe('category_select');
    expect(s.cart).toEqual([]);
  });
});

describe('cartSubtotal', () => {
  it('sums (unit + options) * qty', () => {
    expect(cartSubtotal([item({ unit_price: 1000, option_total: 500, qty: 2 })])).toBe(3000);
  });
});

describe('isManualMode', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('returns false (fail-open) when Supabase env is missing', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await isManualMode({ SUPABASE_URL: undefined } as Env, 'U1');
    expect(res).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns true when a manual_mode row is active', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([{ state: { active: true } }]), { status: 200 }),
    );
    expect(await isManualMode(env(), 'U1')).toBe(true);
  });

  it('returns false when no row exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }));
    expect(await isManualMode(env(), 'U1')).toBe(false);
  });

  it('fails open (false) on Supabase error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status: 500 }));
    expect(await isManualMode(env(), 'U1')).toBe(false);
  });
});

describe('getPkg1Session staleness', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('returns null when the session is older than the stale window', async () => {
    const old = new Date(Date.now() - SESSION_STALE_MS - 1000).toISOString();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([{ state: { step: 'cart_review', cart: [] }, updated_at: old }]), {
        status: 200,
      }),
    );
    expect(await getPkg1Session(env(), 'U1')).toBeNull();
  });

  it('returns the state when fresh', async () => {
    const fresh = new Date().toISOString();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([{ state: { step: 'cart_review', cart: [item()] }, updated_at: fresh }]),
        { status: 200 },
      ),
    );
    const s = await getPkg1Session(env(), 'U1');
    expect(s?.step).toBe('cart_review');
    expect(s?.cart).toHaveLength(1);
  });
});
