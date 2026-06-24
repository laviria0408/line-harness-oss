/**
 * TRYCLE dashboard → bot worker の LINE Push 中継 API。
 *
 * 設計: token 一元化 (20260622-003-dashboard-perfection)。
 *
 *   POST /api/cases/:caseId/push-message
 *   body: { messages: LineMessage[] }   (LINE Messaging API の messages 配列)
 *
 * ## なぜこの endpoint が要るか (真因)
 * dashboard (Vercel) が LINE Push API を直叩きすると、dashboard env の
 * `LINE_CHANNEL_ACCESS_TOKEN` を使う。だが LINE の access token は bot worker の
 * cron (`refreshLineAccessTokens`) が D1 `line_accounts.channel_access_token` を
 * 7 日前倒しで自動更新する。env 側は手動更新しないと乖離し、期限切れ / 別 OA の
 * token で `400 Failed to send messages` になる。
 * → token を「1 箇所 (bot worker・D1 の自動更新値)」に寄せ、dashboard は
 *   この endpoint を内部 token で叩くだけにする。
 *
 * ## token 解決 (step-delivery.ts と同じ動的解決)
 *   caseId → cases.line_user_id (Supabase, tenant スコープ)
 *          → friends.line_account_id (D1)
 *          → line_accounts.channel_access_token (D1, cron 自動更新の最新値)
 *   line_account_id が無ければ env.LINE_CHANNEL_ACCESS_TOKEN に fallback。
 *
 * ## 認証
 *   Authorization: Bearer <DASHBOARD_INTERNAL_TOKEN>  (cases-messages と同じ)
 *
 * ## PII マスキング
 *   line_user_id 生値は log / error response に残さない (マスキング済のみ)。
 *
 * ## エラー中継
 *   LINE の生ステータス + body を response に含める。dashboard 側が
 *   `describeLinePushError` で人間可読化するため、ここでは翻訳しない。
 *
 * ## 会話履歴記録 (2026-06-25)
 *   送信成功後に messages_log へ outgoing を best-effort で記録する。記録しないと
 *   案件詳細「会話履歴」タブに dashboard 起点の push (再予約案内等) が出ない。
 *   body の任意 `source` で分類を上書きできる (既定 'dashboard-push'・いずれも
 *   normalizeDirection で 'bot' 表示)。記録失敗は送信成否に影響しない。
 */
import { Hono } from 'hono';
import type { Env } from '../index.js';
import { resolveCaseLineUserId, verifyDashboardToken } from '../lib/dashboard-auth.js';
import { isValidLineUserId, maskLineUserId, validatePushMessages } from '../lib/push-message-validate.js';
import { recordOutgoingMessages } from '../lib/trycle-outgoing-log.js';

export const pushMessage = new Hono<Env>();

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';

/**
 * friend の line_account_id から最新の channel access token を解決する。
 * line_account_id が無い / 解決失敗時は env の token に fallback する。
 */
async function resolveAccessToken(
  c: { env: Env['Bindings'] },
  lineUserId: string,
): Promise<string | null> {
  const envToken = c.env.LINE_CHANNEL_ACCESS_TOKEN ?? null;
  try {
    const friend = await c.env.DB.prepare(`SELECT line_account_id FROM friends WHERE line_user_id = ?`)
      .bind(lineUserId)
      .first<{ line_account_id: string | null }>();
    const accountId = friend?.line_account_id ?? null;
    if (!accountId) return envToken;

    const { getLineAccountById } = await import('@line-crm/db');
    const account = await getLineAccountById(c.env.DB, accountId);
    // cron 自動更新の最新 token を最優先 (env への fallback は手動運用ゆえ古くなりうる)。
    return account?.channel_access_token ?? envToken;
  } catch (err) {
    console.error('[push-message] resolveAccessToken failed', err);
    return envToken;
  }
}

pushMessage.post('/api/cases/:caseId/push-message', async (c) => {
  // 内部 token 認証 (staff auth は bypass されている)。
  const authResult = verifyDashboardToken(c);
  if (!authResult.ok) {
    return c.json({ success: false, error: authResult.error }, authResult.status);
  }

  const caseId = c.req.param('caseId');

  // body 検証 (messages 配列の構造のみ・内容は LINE に委ねる)。
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'invalid JSON body' }, 400);
  }
  const validation = validatePushMessages(rawBody);
  if (!validation.ok) {
    return c.json({ success: false, error: validation.error }, 400);
  }
  // 任意 source (会話履歴の分類用)。未指定は 'dashboard-push' (normalizeDirection で bot 表示)。
  const rawSource = (rawBody as { source?: unknown }).source;
  const logSource = typeof rawSource === 'string' && rawSource.trim() ? rawSource.trim() : 'dashboard-push';

  try {
    // 1) caseId → line_user_id (Supabase・tenant スコープ)
    const lookup = await resolveCaseLineUserId(c, caseId);
    if (lookup.status === 'tenant_unconfigured') {
      return c.json({ success: false, error: 'tenant not configured' }, 503);
    }
    if (lookup.status === 'not_found') {
      return c.json({ success: false, error: 'case not found' }, 404);
    }
    const lineUserId = lookup.lineUserId;
    if (!lineUserId) {
      // dashboard 起票で LINE 未連携 → 送信不能。現場が直せる入力エラー (409)。
      return c.json(
        { success: false, error: '案件に LINE userId が未設定です。LINE 連携を確認してください。' },
        409,
      );
    }
    if (!isValidLineUserId(lineUserId)) {
      return c.json(
        { success: false, error: 'LINE userId のフォーマットが不正です (期待: U + 32 桁)。' },
        409,
      );
    }

    // 2) 最新 token 解決 (D1 自動更新値を最優先)。
    const token = await resolveAccessToken(c, lineUserId);
    if (!token) {
      return c.json({ success: false, error: 'LINE access token not configured' }, 503);
    }

    // 3) LINE Push API を直叩き (LineClient だと生 status/body を取れず翻訳に使えない)。
    const res = await fetch(LINE_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to: lineUserId, messages: validation.messages }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // 生エラーをそのまま中継 (dashboard が describeLinePushError で翻訳)。
      // line_user_id 生値は含めない (マスキング済のみ log)。
      console.error(
        `[push-message] LINE push failed status=${res.status} to=${maskLineUserId(lineUserId)}`,
      );
      return c.json({ success: false, status: res.status, error: detail }, 502);
    }

    // 送信成功 → 会話履歴へ outgoing を記録 (best-effort・失敗しても送信は成立済)。
    await recordOutgoingMessages(c.env, lineUserId, validation.messages, 'push', logSource);

    return c.json({ success: true });
  } catch (err) {
    // err に line_user_id 生値が混ざる可能性は無い (上で扱わない) が、念のため
    // message のみ返す。
    console.error('[push-message] error:', err instanceof Error ? err.message : 'unknown');
    return c.json(
      { success: false, error: err instanceof Error ? err.message : 'unknown error' },
      500,
    );
  }
});
