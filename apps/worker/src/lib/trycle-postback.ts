/**
 * TRYCLE postback dispatcher (Phase B-4).
 *
 * The Vercel-era bot used "action=pkg1_*", "action=pkg8_*", "action=consent_*"
 * postback prefixes for the maintenance estimate / FAQ / consent flows. To keep
 * upstream `webhook.ts` diff small, we route those prefixes here as a single
 * `tryHandleTryclePostback(...)` call from inside the existing postback branch.
 *
 * Return value:
 *   true  → TRYCLE handled it. Caller MUST NOT continue with auto-reply
 *           matching (we already replied via the LINE Client).
 *   false → not a TRYCLE postback; caller continues with stock LINE Harness
 *           auto_reply / scenario matching.
 *
 * Design note
 *   We don't import quote/store helpers here directly because actually wiring
 *   each Pkg1 step (region → symptom → variant → qty → cart → confirm)
 *   requires session storage that lives in Supabase `bot_sessions`. That full
 *   port is Phase B-3.5 (intentionally deferred to a follow-up commit so the
 *   current PR stays bounded). For now we ack the prefixes and reply with a
 *   clear "feature coming online" message so users don't fall into the
 *   pre-existing auto-reply path mistakenly.
 */
import type { LineClient } from '@line-crm/line-sdk';

const TRYCLE_PREFIXES = [
  'pkg1_',
  'pkg8_',
  'consent_',
  'reservation_',
] as const;

export function isTryclePostback(data: string): boolean {
  return TRYCLE_PREFIXES.some((prefix) => data.startsWith(prefix));
}

export interface TryclePostbackContext {
  readonly replyToken: string;
  readonly lineUserId: string;
  readonly lineClient: LineClient;
}

/**
 * Returns true if the postback was consumed by TRYCLE flow, false otherwise.
 *
 * Stage 1 (Phase B-4) wiring: we ack the postback so the stock auto-reply
 * never picks it up; the rich flows (estimate / consent / reservation) land
 * in a follow-up commit. The reply message is intentionally short so the user
 * sees movement and the postback log captures the action data for analytics.
 */
export async function tryHandleTryclePostback(
  data: string,
  ctx: TryclePostbackContext,
): Promise<boolean> {
  if (!isTryclePostback(data)) {
    return false;
  }
  const message = trycleAckMessage(data);
  try {
    await ctx.lineClient.replyMessage(ctx.replyToken, [
      { type: 'text', text: message },
    ]);
  } catch (err) {
    console.error('[trycle-postback] reply failed', err);
  }
  return true;
}

function trycleAckMessage(data: string): string {
  if (data.startsWith('pkg1_start')) {
    return '整備見積もりフローを準備中です。スタッフからご連絡いたします。';
  }
  if (data.startsWith('pkg1_wage')) {
    return '工賃表と同意書のご案内を準備中です。';
  }
  if (data.startsWith('pkg1_staff')) {
    return 'スタッフへの相談を準備中です。担当者から折り返しご連絡いたします。';
  }
  if (data.startsWith('pkg1_')) {
    return '整備関連のフローを準備中です。';
  }
  if (data.startsWith('pkg8_start') || data.startsWith('faq_start')) {
    return 'FAQ をご案内します。準備中です。';
  }
  if (data.startsWith('consent_')) {
    return '同意書フローを準備中です。';
  }
  if (data.startsWith('reservation_')) {
    return '来店予約フローを準備中です。';
  }
  return `承りました: ${data}`;
}
