/**
 * TRYCLE postback dispatcher.
 *
 * Phase B-4 で stub として組み込まれた経路を、Phase E-impl Step 2 で Pkg8
 * (FAQ) は完全実装に置き換えた。Pkg1 (整備見積) / consent / reservation は
 * Step 4-6 で書き直す対象として stub のまま残置 (LH 標準 + 個別維持の混成
 * 設計に従う・「LH 標準活用設計 v1.0 (Phase C-3)」§5 / §6 参照)。
 *
 * Return value:
 *   true  → TRYCLE handled it. Caller MUST NOT continue with auto-reply
 *           matching (we already replied via the LINE Client).
 *   false → not a TRYCLE postback; caller continues with stock LINE Harness
 *           auto_reply / scenario matching.
 */
import type { LineClient } from '@line-crm/line-sdk';
import { handlePkg8Postback, isPkg8Postback } from './trycle-pkg8.js';
import type { TrycleRepoEnv } from './trycle-repo.js';

const TRYCLE_STUB_PREFIXES = [
  'pkg1_',
  'consent_',
  'reservation_',
] as const;

export function isTryclePostback(data: string): boolean {
  return isPkg8Postback(data) || TRYCLE_STUB_PREFIXES.some((prefix) => data.startsWith(prefix));
}

export interface TryclePostbackContext {
  readonly replyToken: string;
  readonly lineUserId: string;
  readonly lineClient: LineClient;
  readonly env: TrycleRepoEnv;
}

export async function tryHandleTryclePostback(
  data: string,
  ctx: TryclePostbackContext,
): Promise<boolean> {
  // Pkg8 (FAQ) は Phase E-impl Step 2 で完全実装
  if (isPkg8Postback(data)) {
    return handlePkg8Postback(data, ctx);
  }
  // Pkg1 / consent / reservation は Phase E-impl Step 4-6 で書き直す対象。
  // 暫定 ack で auto-reply 経路には流さない (重複返信防止)。
  if (TRYCLE_STUB_PREFIXES.some((prefix) => data.startsWith(prefix))) {
    const message = trycleStubAckMessage(data);
    try {
      await ctx.lineClient.replyMessage(ctx.replyToken, [{ type: 'text', text: message }]);
    } catch (err) {
      console.error('[trycle-postback] stub reply failed', err);
    }
    return true;
  }
  return false;
}

function trycleStubAckMessage(data: string): string {
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
  if (data.startsWith('consent_')) {
    return '同意書フローを準備中です。';
  }
  if (data.startsWith('reservation_')) {
    return '来店予約フローを準備中です。';
  }
  return `承りました: ${data}`;
}
