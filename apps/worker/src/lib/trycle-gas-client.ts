/**
 * Apps Script Web App client (Phase B-6).
 *
 * Ported from `trycle-line-harness/src/lib/gas-client.ts`. The change vs. the
 * Vercel-era version is that GAS_WEB_APP_URL comes through Hono's Env binding
 * instead of `process.env` — Cloudflare Workers don't have process.env.
 *
 * Apps Script project owns:
 *   - `estimate_pdf` : build a maintenance estimate PDF from a quote payload
 *   - `drive_save`   : save an arbitrary byte payload into Google Drive
 *   - `gmail_notify` : send a notification email via Gmail
 *
 * All requests are POST + JSON, and Apps Script responds with `{ ok, data?, error? }`.
 */

import type { Env } from '../index.js';

export type GasRequestType = 'estimate_pdf' | 'drive_save' | 'gmail_notify';

export interface GasRequest {
  readonly type: GasRequestType;
  readonly payload: Record<string, unknown>;
}

export interface GasResponse {
  readonly ok: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: string;
}

export async function callGas(
  env: Env['Bindings'],
  req: GasRequest,
): Promise<GasResponse> {
  if (!env.GAS_WEB_APP_URL) {
    console.error(`[gas-client] GAS_WEB_APP_URL not configured (type=${req.type})`);
    return { ok: false, error: 'GAS_WEB_APP_URL not configured' };
  }
  try {
    const res = await fetch(env.GAS_WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(
        `[gas-client] GAS responded ${res.status} (type=${req.type}): ${body.slice(0, 300)}`,
      );
      return { ok: false, error: `GAS responded ${res.status}` };
    }
    const parsed = (await res.json()) as GasResponse;
    if (!parsed.ok) {
      console.error(
        `[gas-client] GAS returned ok=false (type=${req.type}): ${parsed.error ?? 'no error field'}`,
      );
    }
    return parsed;
  } catch (err) {
    console.error(`[gas-client] GAS request threw (type=${req.type}):`, err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
