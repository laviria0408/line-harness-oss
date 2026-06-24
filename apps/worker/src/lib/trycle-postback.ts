/**
 * TRYCLE postback dispatcher.
 *
 *   - Pkg8 (FAQ)      : isPkg8Postback / handlePkg8Postback
 *   - Pkg1 (整備見積) : isPkg1Postback / handlePkg1Postback (本物モデル・経路 A〜E)
 *                       postback は本物 `action=pkg1_X&value=Y` 形式 + 素の
 *                       `pkg1_start` / `pkg1_wage`。datetimepicker の選択値は
 *                       postback.params.datetime で来るため datetime を渡す。
 *   - reservation_    : 各種予約 3 分岐 + 来店予定ゲート (Phase 4・trycle-reservation-gate.ts)。
 *                       reservation_maintenance だけはここで pkg1_start に橋渡しする。
 *   - consent_        : 同意書は LIFF (apps/consent-liff/) → HTTP route で取得 (stub)
 *
 * Return value:
 *   true  → TRYCLE handled it. Caller MUST NOT continue with auto-reply matching.
 *   false → not a TRYCLE postback; caller continues with stock auto_reply / scenario.
 */
import type { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../index.js';
import { handlePkg8Postback, isPkg8Postback } from './trycle-pkg8.js';
import { handlePkg1Postback, isPkg1Postback } from './trycle-pkg1.js';
import { startStaffConsultFromPkg1 } from './trycle-staff.js';
import {
  handleReservationGatePostback,
  isReservationPostback,
} from './trycle-reservation-gate.js';
import type { TrycleRepoEnv } from './trycle-repo.js';

const TRYCLE_STUB_PREFIXES = ['consent_'] as const;

export function isTryclePostback(data: string): boolean {
  return (
    isPkg8Postback(data) ||
    isPkg1Postback(data) ||
    isReservationPostback(data) ||
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
  // pkg1_staff (リッチメニュー「スタッフに相談」直接タップ): Phase 4 escalate refactor 後の
  // 補完経路。handlePkg1Postback には対応 handler が無いため、ここで intercept して
  // 共通スタッフ相談フロー (B1 内容確認ループ) に直接入る。
  if (data === 'pkg1_staff') {
    await startStaffConsultFromPkg1(
      {
        replyToken: ctx.replyToken,
        lineUserId: ctx.lineUserId,
        lineClient: ctx.lineClient,
        env: ctx.env,
      },
      '',
      'リッチメニューからスタッフ相談',
    );
    return true;
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
  // 各種予約 (Phase 4): 3 分岐 + 来店予定ゲート。「メンテナンスの予約」は Pkg1 通常
  // フローへ橋渡しする (gate は reservation_maintenance を未処理で返すので、ここで
  // pkg1_start を発火する)。それ以外の reservation_ は gate が完結処理する。
  if (isReservationPostback(data)) {
    if (parseAction(data) === 'reservation_maintenance') {
      return handlePkg1Postback('pkg1_start', {
        replyToken: ctx.replyToken,
        lineUserId: ctx.lineUserId,
        lineClient: ctx.lineClient,
        env: ctx.env,
        datetime: ctx.datetime,
      });
    }
    return handleReservationGatePostback(data, {
      replyToken: ctx.replyToken,
      lineUserId: ctx.lineUserId,
      lineClient: ctx.lineClient,
      env: ctx.env,
    });
  }
  // consent_ は通常ここに来ない (LIFF / 来店予定ヒアリングへ統合)。
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

/** postback data の `action=` を取り出す (素のトークンはそのまま返す)。 */
function parseAction(data: string): string {
  if (!data.includes('action=')) return data;
  return new URLSearchParams(data).get('action') ?? '';
}
