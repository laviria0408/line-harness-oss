/**
 * TRYCLE postback dispatcher.
 *
 *   - Pkg8 (FAQ)      : isPkg8Postback / handlePkg8Postback
 *   - Pkg1 (整備見積) : isPkg1Postback / handlePkg1Postback (本物モデル・経路 A〜E)
 *                       postback は本物 `action=pkg1_X&value=Y` 形式 + 素の
 *                       `pkg1_start` / `pkg1_wage`。datetimepicker の選択値は
 *                       postback.params.datetime で来るため datetime を渡す。
 *   - consent_        : 同意書は LIFF (apps/consent-liff/) → HTTP route で取得 (stub)
 *   - reservation_    : 旧予約導線。Pkg1 の「来店予定」に統合済 (stub)
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
  /** datetimepicker の選択値 (postback.params.datetime)。Pkg1 来店予定の日時。 */
  readonly datetime?: string;
}

export async function tryHandleTryclePostback(
  data: string,
  ctx: TryclePostbackContext,
): Promise<boolean> {
  // Pkg8 (FAQ)
  if (isPkg8Postback(data)) {
    return handlePkg8Postback(data, {
      replyToken: ctx.replyToken,
      lineUserId: ctx.lineUserId,
      lineClient: ctx.lineClient,
      env: ctx.env as TrycleRepoEnv,
    });
  }
  // Pkg1 (整備見積・本物モデル)
  if (isPkg1Postback(data)) {
    return handlePkg1Postback(data, {
      replyToken: ctx.replyToken,
      lineUserId: ctx.lineUserId,
      lineClient: ctx.lineClient,
      env: ctx.env,
      datetime: ctx.datetime,
    });
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
