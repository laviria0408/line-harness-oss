/**
 * TRYCLE postback dispatcher.
 *
 * Phase B-4 で stub として組み込まれた経路を順次実装に置き換えている。
 *   - Pkg8 (FAQ)      : Phase E-impl Step 2 で完全実装
 *   - Pkg1 (整備見積) : Phase E-impl Step 4-7 で完全実装 (handlePkg1Postback)
 *   - consent_        : 同意書は LIFF (apps/consent-liff/) → HTTP route (routes/consent.ts)
 *                       で取得するため postback では使わない (誤発火時の保険 stub)
 *   - reservation_    : 旧予約導線。Pkg1 では「来店予定ヒアリング」に統合済のため
 *                       未使用 (将来 Pkg5 Booking 用に予約・stub のまま残置)
 *
 * Return value:
 *   true  → TRYCLE handled it. Caller MUST NOT continue with auto-reply matching.
 *   false → not a TRYCLE postback; caller continues with stock auto_reply / scenario.
 */
import type { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../index.js';
import { handlePkg8Postback, isPkg8Postback } from './trycle-pkg8.js';
import { handlePkg1Postback, isPkg1Postback } from './trycle-pkg1.js';
import type { TrycleRepoEnv } from './trycle-repo.js';

const TRYCLE_STUB_PREFIXES = ['consent_', 'reservation_'] as const;

export function isTryclePostback(data: string): boolean {
  return (
    isPkg8Postback(data) ||
    isPkg1Postback(data) ||
    TRYCLE_STUB_PREFIXES.some((prefix) => data.startsWith(prefix))
  );
}

export interface TryclePostbackContext {
  readonly replyToken: string;
  readonly lineUserId: string;
  readonly lineClient: LineClient;
  readonly env: Env['Bindings'];
}

export async function tryHandleTryclePostback(
  data: string,
  ctx: TryclePostbackContext,
): Promise<boolean> {
  // Pkg8 (FAQ) — Phase E-impl Step 2 で完全実装。
  if (isPkg8Postback(data)) {
    return handlePkg8Postback(data, {
      replyToken: ctx.replyToken,
      lineUserId: ctx.lineUserId,
      lineClient: ctx.lineClient,
      env: ctx.env as TrycleRepoEnv,
    });
  }
  // Pkg1 (整備見積) — Phase E-impl Step 4-7 で完全実装。
  if (isPkg1Postback(data)) {
    return handlePkg1Postback(data, ctx);
  }
  // consent_ / reservation_ は通常ここに来ない (LIFF / 来店予定ヒアリングへ統合)。
  // 誤発火しても auto-reply 経路には流さない (重複返信防止)。
  if (TRYCLE_STUB_PREFIXES.some((prefix) => data.startsWith(prefix))) {
    try {
      await ctx.lineClient.replyMessage(ctx.replyToken, [
        { type: 'text', text: '承りました。スタッフよりご案内いたします。' },
      ]);
    } catch (err) {
      console.error('[trycle-postback] stub reply failed', err);
    }
    return true;
  }
  return false;
}
