/**
 * dashboard → bot worker の LINE Push 中継 (push-message) 用の純粋ヘルパー。
 *
 * route 本体は I/O (Supabase / D1 / fetch) に専念し、ここは「入力検証」と
 * 「PII マスキング」の責務だけを持つ (単体テスト可能にするため切り出し)。
 *
 * LINE userId 生値は log / error response に残さない。マスキングは
 * 先頭 4 文字 + 末尾の桁数のみ ("Uabc…(32)") に留める。
 */

/** LINE userId は `U` + 32 桁 hex (cases-messages / quote-payload-schema と同一規則)。 */
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/i;
/** LINE Push API の messages は 1〜5 件 (公式仕様)。 */
const MAX_MESSAGES = 5;

/** 構造検証を通った 1 件 (type は string 保証・内容は LINE 側に委ねる)。 */
export type ValidatedMessage = { readonly type: string; readonly [key: string]: unknown };

export type MessagesValidation =
  | { readonly ok: true; readonly messages: ReadonlyArray<ValidatedMessage> }
  | { readonly ok: false; readonly error: string };

/**
 * dashboard から受けた `{ messages: [...] }` を検証する。
 *
 * - 配列であること・1〜5 件であること・各要素が `type` を持つ object であること。
 * 内容そのものの妥当性 (Flex schema 等) は LINE 側に委ね、ここでは構造だけ弾く。
 */
export function validatePushMessages(body: unknown): MessagesValidation {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return { ok: false, error: 'messages must be an array' };
  }
  if (messages.length === 0) {
    return { ok: false, error: 'messages must not be empty' };
  }
  if (messages.length > MAX_MESSAGES) {
    return { ok: false, error: `messages must be <= ${MAX_MESSAGES} (LINE Push API 上限)` };
  }
  for (const m of messages) {
    if (typeof m !== 'object' || m === null || typeof (m as { type?: unknown }).type !== 'string') {
      return { ok: false, error: 'each message must be an object with a string "type"' };
    }
  }
  return { ok: true, messages: messages as ReadonlyArray<ValidatedMessage> };
}

/** 送信先 LINE userId のフォーマット検証 (生値はここで止め、route は cleaned のみ使う)。 */
export function isValidLineUserId(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && LINE_USER_ID_RE.test(raw);
}

/**
 * line_user_id を log / error 用にマスキングする。
 *
 *   "Uabcdef0123…(33)" のように先頭 4 文字 + 全長のみ残す。生値は決して返さない。
 */
export function maskLineUserId(raw: string | null | undefined): string {
  if (!raw) return '(none)';
  const head = raw.slice(0, 4);
  return `${head}…(${raw.length})`;
}
