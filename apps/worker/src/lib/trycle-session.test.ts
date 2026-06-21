import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isManualMode,
  cartSubtotal,
  emptyPkg1State,
  getPkg1Session,
  getPkg1Cart,
  SESSION_STALE_MS,
} from './trycle-session.js';
import type { TrycleRepoEnv } from './trycle-repo.js';
import type { QuoteLineItem } from './quote.js';

type Env = TrycleRepoEnv;

function env(): Env {
  return {
    SUPABASE_URL: 'https://sb.example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
    TRYCLE_TENANT_ID: 't-1',
  } as Env;
}

function item(p: Partial<QuoteLineItem> = {}): QuoteLineItem {
  return {
    name: 'n',
    unitPrice: 1000,
    unitPriceMax: null,
    qty: 1,
    amount: 1000,
    amountMax: 1000,
    ...p,
  };
}

describe('emptyPkg1State (本物 startFlow)', () => {
  it('starts at awaiting_dispatch with an empty cart', () => {
    const s = emptyPkg1State();
    expect(s.step).toBe('awaiting_dispatch');
    expect(s.cart).toEqual([]);
  });
});

describe('cartSubtotal', () => {
  it('sums line item amounts', () => {
    expect(cartSubtotal([item({ amount: 3000 }), item({ amount: 1500 })])).toBe(4500);
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
      new Response(
        JSON.stringify([{ state: { step: 'awaiting_cart_decision', cart: [] }, updated_at: old }]),
        { status: 200 },
      ),
    );
    expect(await getPkg1Session(env(), 'U1')).toBeNull();
  });

  it('returns the state (本物 step) when fresh', async () => {
    const fresh = new Date().toISOString();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          { state: { step: 'awaiting_cart_decision', cart: [item()] }, updated_at: fresh },
        ]),
        { status: 200 },
      ),
    );
    const s = await getPkg1Session(env(), 'U1');
    expect(s?.step).toBe('awaiting_cart_decision');
    expect(s?.cart).toHaveLength(1);
  });
});

describe('getPkg1Cart (同意書未取得時の cart 退避)', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('returns the stashed cart array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([{ state: { cart: [item()] } }]), { status: 200 }),
    );
    const cart = await getPkg1Cart(env(), 'U1');
    expect(cart).toHaveLength(1);
  });

  it('returns null when no stash exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }));
    expect(await getPkg1Cart(env(), 'U1')).toBeNull();
  });
});
