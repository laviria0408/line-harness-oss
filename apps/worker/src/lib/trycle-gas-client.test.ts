import { describe, it, expect, beforeEach, vi } from 'vitest';
import { callGas } from './trycle-gas-client.js';
import type { Env } from '../index.js';

type Bindings = Env['Bindings'];

function makeEnv(overrides: Partial<Bindings> = {}): Bindings {
  return { GAS_WEB_APP_URL: 'https://script.example.com/exec', ...overrides } as Bindings;
}

describe('callGas', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns error when GAS_WEB_APP_URL is not configured', async () => {
    const env = { ...makeEnv(), GAS_WEB_APP_URL: undefined } as Bindings;
    const res = await callGas(env, { type: 'estimate_pdf', payload: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/GAS_WEB_APP_URL/);
  });

  it('POSTs JSON and returns parsed response on 200', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { url: 'https://drive.example/x.pdf' } }), {
        status: 200,
      }),
    );
    const env = makeEnv();
    const res = await callGas(env, { type: 'estimate_pdf', payload: { quote_no: 'Q-1' } });
    expect(res.ok).toBe(true);
    expect(res.data?.url).toBe('https://drive.example/x.pdf');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://script.example.com/exec',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      type: 'estimate_pdf',
      payload: { quote_no: 'Q-1' },
    });
  });

  it('returns error on non-OK HTTP status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const res = await callGas(makeEnv(), { type: 'drive_save', payload: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/500/);
  });

  it('returns error on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const res = await callGas(makeEnv(), { type: 'gmail_notify', payload: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/network down/);
  });
});
