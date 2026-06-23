import { extractFlexAltText } from '../utils/flex-alt-text.js';
import {
  getFriendScenariosDueForDelivery,
  getScenarioSteps,
  advanceFriendScenario,
  completeFriendScenario,
  claimFriendScenarioForDelivery,
  getFriendById,
  jstNow,
  computeNextDeliveryAt,
  resolveStepContent,
  addTagToFriend,
  type DeliveryMode,
} from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import type { Message } from '@line-crm/line-sdk';
import { jitterDeliveryTime, addJitter, sleep } from './stealth.js';

/**
 * Replace template variables in message content.
 *
 * Supported variables:
 * - {{name}}                → friend's display name
 * - {{uid}}                 → friend's user UUID
 * - {{friend_id}}           → friend's internal ID
 * - {{auth_url:CHANNEL_ID}} → full /auth/line URL with uid for cross-account linking
 * - {{metadata.KEY}}       → friend's metadata value (from form responses etc.)
 */
export function expandVariables(
  content: string,
  friend: { id: string; display_name: string | null; user_id: string | null; ref_code?: string | null; metadata?: Record<string, unknown> | string | null },
  apiOrigin?: string,
): string {
  let result = content;
  result = result.replace(/\{\{name\}\}/g, friend.display_name || '');
  result = result.replace(/\{\{uid\}\}/g, friend.user_id || '');
  result = result.replace(/\{\{friend_id\}\}/g, friend.id);
  result = result.replace(/\{\{ref\}\}/g, friend.ref_code || '');
  // Conditional block: {{#if_ref}}...{{/if_ref}} — only shown if ref_code exists
  if (friend.ref_code) {
    result = result.replace(/\{\{#if_ref\}\}([\s\S]*?)\{\{\/if_ref\}\}/g, '$1');
  } else {
    result = result.replace(/\{\{#if_ref\}\}[\s\S]*?\{\{\/if_ref\}\}/g, '');
  }
  // Metadata variables: {{metadata.KEY}} → value from friend's metadata
  const meta = friend.metadata
    ? (typeof friend.metadata === 'string' ? JSON.parse(friend.metadata) as Record<string, unknown> : friend.metadata)
    : {};
  // Conditional block: {{#if_metadata.KEY}}...{{/if_metadata.KEY}} — only shown if metadata key has a value
  // When inside JSON arrays, removes the element and fixes trailing/leading commas
  result = result.replace(/\{\{#if_metadata\.([^}]+)\}\}([\s\S]*?)\{\{\/if_metadata\.\1\}\}/g, (_match, key, inner) => {
    const val = meta[key];
    if (val == null || val === '') return '';
    return inner;
  });
  // Clean up broken JSON commas from removed conditional blocks (e.g. ",," or "[," or ",]")
  result = result.replace(/,\s*,/g, ',');
  result = result.replace(/\[\s*,/g, '[');
  result = result.replace(/,\s*\]/g, ']');
  result = result.replace(/\{\{metadata\.([^}]+)\}\}/g, (_match, key) => {
    const val = meta[key];
    if (val == null) return '';
    return Array.isArray(val) ? val.join(', ') : String(val);
  });
  if (apiOrigin) {
    result = result.replace(/\{\{auth_url:([^}]+)\}\}/g, (_match, channelId) => {
      const params = new URLSearchParams({ account: channelId, ref: 'cross-link' });
      if (friend.user_id) params.set('uid', friend.user_id);
      return `${apiOrigin}/auth/line?${params.toString()}`;
    });
  }
  return result;
}

/**
 * Resolve metadata for a friend, merging across all UUID-linked records.
 * Falls back to the friend's own metadata if no user_id.
 */
export async function resolveMetadata(
  db: D1Database,
  friend: { user_id?: string | null; metadata?: string | null },
): Promise<Record<string, unknown>> {
  // If friend has a UUID, merge metadata from all linked records
  if (friend.user_id) {
    const { getMergedMetadataByUserId } = await import('@line-crm/db');
    return getMergedMetadataByUserId(db, friend.user_id);
  }
  // Fallback: parse own metadata
  if (friend.metadata) {
    try { return JSON.parse(friend.metadata); } catch { return {}; }
  }
  return {};
}

const MAX_SENDS_PER_CRON = 40; // CF Free plan: 50 subrequests limit (margin for other jobs)

export async function processStepDeliveries(
  db: D1Database,
  lineClient: LineClient,
  workerUrl?: string,
): Promise<void> {
  const now = jstNow();
  const dueFriendScenarios = await getFriendScenariosDueForDelivery(db, now);

  let sendCount = 0;
  for (let i = 0; i < dueFriendScenarios.length; i++) {
    if (sendCount >= MAX_SENDS_PER_CRON) break;
    const fs = dueFriendScenarios[i];
    try {
      // Stealth: add small random delay between deliveries to avoid burst patterns
      if (i > 0) {
        await sleep(addJitter(50, 200));
      }
      const sent = await processSingleDelivery(db, lineClient, fs, workerUrl);
      if (sent) sendCount++;
    } catch (err) {
      console.error(`Error processing friend_scenario ${fs.id}:`, err);
      // Continue with next one
    }
  }
}

async function processSingleDelivery(
  db: D1Database,
  lineClient: LineClient,
  fs: {
    id: string;
    friend_id: string;
    scenario_id: string;
    current_step_order: number;
    status: string;
    next_delivery_at: string | null;
    started_at: string;
  },
  workerUrl?: string,
): Promise<boolean> {
  // Optimistic lock: claim this delivery (prevents duplicate sends from parallel workers)
  const claimed = await claimFriendScenarioForDelivery(db, fs.id, fs.current_step_order);
  if (!claimed) return false;

  const friend = await getFriendById(db, fs.friend_id);
  if (!friend || !friend.is_following) {
    await completeFriendScenario(db, fs.id);
    return false;
  }

  // Fetch scenario row for delivery_mode (needed by computeNextDeliveryAt below)
  const scenarioRow = await db
    .prepare(`SELECT delivery_mode FROM scenarios WHERE id = ?`)
    .bind(fs.scenario_id)
    .first<{ delivery_mode: DeliveryMode }>();
  if (!scenarioRow) {
    await completeFriendScenario(db, fs.id);
    return false;
  }

  // Get all steps for this scenario
  const steps = await getScenarioSteps(db, fs.scenario_id);
  if (steps.length === 0) {
    await completeFriendScenario(db, fs.id);
    return false;
  }

  // computeNextDeliveryAt は「JST clock-time を UTC として表現する Date」前提
  // (setHours/getDate が JST clock 通りに動くようにオフセット済みの Date)。
  // fs.started_at は "+09:00" 付き ISO で本物の UTC instant として parse されるため、
  // +9h ずらして JST clock-time 表現に揃える必要がある。
  const enrolledAtDate = new Date(new Date(fs.started_at).getTime() + 9 * 60 * 60_000);
  const nowJstDate = new Date(Date.now() + 9 * 60 * 60_000);
  const nextDeliveryFor = (step: { delay_minutes: number; offset_days: number | null; offset_minutes: number | null; delivery_time: string | null }): Date =>
    computeNextDeliveryAt(
      { delivery_mode: scenarioRow.delivery_mode },
      step,
      { enrolledAt: enrolledAtDate, previousDeliveredAt: nowJstDate, now: nowJstDate },
    );

  // Steps are sorted by step_order but may not be contiguous (e.g., 1, 3, 5 after deletions).
  // Find the next step whose step_order > current_step_order.
  const currentStep = steps.find((s) => s.step_order > fs.current_step_order);

  if (!currentStep) {
    await completeFriendScenario(db, fs.id);
    return false;
  }

  // Check step condition before sending
  if (currentStep.condition_type) {
    const conditionMet = await evaluateCondition(db, fs.friend_id, currentStep);
    if (!conditionMet) {
      if (currentStep.next_step_on_false !== null && currentStep.next_step_on_false !== undefined) {
        const jumpStep = steps.find((s) => s.step_order === currentStep.next_step_on_false);
        if (jumpStep) {
          const jitteredDate = jitterDeliveryTime(nextDeliveryFor(jumpStep));
          await advanceFriendScenario(db, fs.id, currentStep.step_order, jitteredDate.toISOString().slice(0, -1) + '+09:00');
          return false;
        }
      }
      const nextIndex = steps.indexOf(currentStep) + 1;
      if (nextIndex < steps.length) {
        const nextStep = steps[nextIndex];
        const jitteredDate = jitterDeliveryTime(nextDeliveryFor(nextStep));
        await advanceFriendScenario(db, fs.id, currentStep.step_order, jitteredDate.toISOString().slice(0, -1) + '+09:00');
      } else {
        await completeFriendScenario(db, fs.id);
      }
      return false;
    }
  }

  // Resolve template_id → templates table (参照型). template_id 未設定なら step 値そのまま。
  const resolved = await resolveStepContent(db, currentStep);

  // Expand template variables ({{name}}, {{uid}}, {{auth_url:CHANNEL_ID}}, {{metadata.KEY}}, etc.)
  const resolvedMeta = await resolveMetadata(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
  const friendWithMeta = { ...friend, metadata: resolvedMeta } as Parameters<typeof expandVariables>[1];
  const expandedContent = expandVariables(resolved.messageContent, friendWithMeta, workerUrl);
  // Auto-wrap URLs with tracking links (text with URLs → Flex with button)
  let trackedType: string = resolved.messageType;
  let trackedContent = expandedContent;
  if (workerUrl) {
    const { autoTrackContent } = await import('./auto-track.js');
    const tracked = await autoTrackContent(db, resolved.messageType, expandedContent, workerUrl);
    trackedType = tracked.messageType;
    trackedContent = tracked.content;
  }
  const message = buildMessage(trackedType, trackedContent);
  // Resolve the correct LINE client for this friend's account
  let deliveryClient = lineClient;
  const friendAccountId = (friend as unknown as Record<string, string | null>).line_account_id;
  if (friendAccountId) {
    const { getLineAccountById } = await import('@line-crm/db');
    const account = await getLineAccountById(db, friendAccountId);
    if (account) {
      const { LineClient: LC } = await import('@line-crm/line-sdk');
      deliveryClient = new LC(account.channel_access_token);
    }
  }
  await deliveryClient.pushMessage(friend.line_user_id, [message]);

  // Log what we actually pushed: variables expanded, URLs auto-tracked, AND
  // any cleanEmptyNodes() mutation or parse-failure text fallback applied by
  // buildMessage(). Use scenario_step_id to recover the original template.
  const logId = crypto.randomUUID();
  const logPayload = messageToLogPayload(message);
  await db
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, template_id_at_send, created_at)
       VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, 'scenario', ?, ?)`,
    )
    .bind(logId, friend.id, logPayload.messageType, logPayload.content, currentStep.id, resolved.templateIdAtSend, jstNow())
    .run();

  // Determine next step (find the step after currentStep in the sorted list)
  const currentIndex = steps.indexOf(currentStep);
  const nextStep = currentIndex + 1 < steps.length ? steps[currentIndex + 1] : null;

  if (nextStep) {
    const jitteredDate = jitterDeliveryTime(nextDeliveryFor(nextStep));
    await advanceFriendScenario(db, fs.id, currentStep.step_order, jitteredDate.toISOString().slice(0, -1) + '+09:00');
  } else {
    // This was the last step
    await completeFriendScenario(db, fs.id);
  }

  // 到達タグ付与 (advance / complete の後 = 再送が起きてもタグ付与は影響しない順序)
  // 失敗してもログに残すだけで配信フローは止めない。
  if (currentStep.on_reach_tag_id) {
    try {
      await addTagToFriend(db, friend.id, currentStep.on_reach_tag_id);
    } catch (err) {
      console.error(`[scenario] tag attach failed step=${currentStep.id}:`, err);
    }
  }
  return true;
}

export const SUPPORTED_CONDITION_TYPES = [
  'tag_exists',
  'tag_not_exists',
  'metadata_equals',
  'metadata_not_equals',
] as const;

export function isSupportedConditionType(value: unknown): value is (typeof SUPPORTED_CONDITION_TYPES)[number] {
  return typeof value === 'string' && (SUPPORTED_CONDITION_TYPES as readonly string[]).includes(value);
}

export async function evaluateCondition(
  db: D1Database,
  friendId: string,
  step: { condition_type: string | null; condition_value: string | null },
): Promise<boolean> {
  if (!step.condition_type) return true;
  if (!isSupportedConditionType(step.condition_type)) {
    console.error(`[scenario] unsupported condition_type: ${step.condition_type}`);
    return false;
  }
  if (!step.condition_value) {
    console.error(`[scenario] missing condition_value for condition_type: ${step.condition_type}`);
    return false;
  }

  try {
    switch (step.condition_type) {
      case 'tag_exists': {
        const tag = await db
          .prepare('SELECT 1 FROM friend_tags WHERE friend_id = ? AND tag_id = ?')
          .bind(friendId, step.condition_value)
          .first();
        return !!tag;
      }
      case 'tag_not_exists': {
        const tag = await db
          .prepare('SELECT 1 FROM friend_tags WHERE friend_id = ? AND tag_id = ?')
          .bind(friendId, step.condition_value)
          .first();
        return !tag;
      }
      case 'metadata_equals':
      case 'metadata_not_equals': {
        const parsed = JSON.parse(step.condition_value) as { key?: unknown; value?: unknown };
        if (typeof parsed.key !== 'string' || !Object.prototype.hasOwnProperty.call(parsed, 'value')) {
          console.error('[scenario] malformed metadata condition_value');
          return false;
        }
        const friend = await db
          .prepare('SELECT metadata FROM friends WHERE id = ?')
          .bind(friendId)
          .first<{ metadata: string }>();
        let metadata: Record<string, unknown> = {};
        try {
          metadata = JSON.parse(friend?.metadata || '{}') as Record<string, unknown>;
        } catch {
          metadata = {};
        }
        const matches = metadata[parsed.key] === parsed.value;
        return step.condition_type === 'metadata_equals' ? matches : !matches;
      }
    }
  } catch (err) {
    console.error('[scenario] condition evaluation failed', err);
    return false;
  }
}


/** Remove empty text nodes and boxes with empty text from Flex JSON */
function cleanEmptyNodes(obj: unknown): void {
  if (!obj || typeof obj !== 'object') return;
  const node = obj as Record<string, unknown>;
  for (const key of ['header', 'body', 'footer']) {
    if (node[key]) cleanEmptyNodes(node[key]);
  }
  if (Array.isArray(node.contents)) {
    // First clean children recursively
    for (const c of node.contents as unknown[]) cleanEmptyNodes(c);
    // Then filter out empty nodes
    node.contents = (node.contents as unknown[]).filter((c) => {
      if (!c || typeof c !== 'object') return true;
      const child = c as Record<string, unknown>;
      // Remove empty text nodes
      if (child.type === 'text') {
        const text = child.text;
        return typeof text === 'string' && text.trim().length > 0;
      }
      // Remove box nodes where any text child is empty (metadata rows with no value)
      if (child.type === 'box' && Array.isArray(child.contents)) {
        const texts = (child.contents as Array<Record<string, unknown>>).filter(t => t.type === 'text');
        if (texts.length >= 2) {
          // horizontal box with label + value — remove if value is empty
          const hasEmptyText = texts.some(t => typeof t.text === 'string' && t.text.trim() === '');
          if (hasEmptyText) return false;
        }
      }
      return true;
    });
  }
}

/**
 * Derive (messageType, content) from a built `Message` object so that what
 * lands in messages_log mirrors what was actually pushed to LINE — including
 * cleanEmptyNodes() mutations and any parse-failure text fallback inside
 * buildMessage(). Use this whenever you log a message you just pushed.
 */
export function messageToLogPayload(message: Message): { messageType: string; content: string } {
  if (message.type === 'text') return { messageType: 'text', content: message.text };
  if (message.type === 'flex') {
    // 会話履歴 (dashboard / LH 管理画面) で raw JSON が dump されると UI が崩壊する。
    // altText (見出し) に加えて Flex 内の本文テキスト・選択肢ラベルを抽出し、
    // 「📋 {altText}\n選択肢:\n- {label1}\n- {label2}…」形式で人間可読に保存する
    // (raw JSON は捨てる)。これで「bot が何を提示し、どの選択肢があったか」が
    // 会話履歴だけで完全に読める (Phase 1)。
    return { messageType: 'flex', content: flexLogContent(message.altText, message.contents) };
  }
  if (message.type === 'template') {
    // template も altText 必須。raw template JSON は保存しない。
    return { messageType: 'template', content: flexLogContent(message.altText, undefined) };
  }
  if (message.type === 'image') {
    return {
      messageType: 'image',
      content: JSON.stringify({
        originalContentUrl: message.originalContentUrl,
        previewImageUrl: message.previewImageUrl,
      }),
    };
  }
  return { messageType: message.type, content: JSON.stringify(message) };
}

/** 1 つの Flex content から抽出する深さ上限 (循環/巨大 JSON の保険)。 */
const FLEX_EXTRACT_MAX_DEPTH = 12;
/** 会話履歴に出す選択肢ラベルの上限件数 (carousel 全展開での暴発を防ぐ)。 */
const FLEX_MAX_CHOICE_LABELS = 40;

/**
 * Flex / template の messages_log content を会話履歴向けに整える。
 *
 *   `[flex] {見出し}`                         … 見出しだけ (選択肢が無い場合)
 *   `[flex] {見出し}\n選択肢:\n- {A}\n- {B}…`  … tap row / button の選択肢付き
 *
 * 見出しは altText を優先し、空なら本文の先頭テキストを救出する。選択肢は Flex 内の
 * postback / message / uri action を持つ tap row・button のラベルから抽出する
 * (見出しと重複するラベルは除外)。altText も本文も無ければ `[flex]` のみ。
 */
export function flexLogContent(altText: unknown, contents: unknown): string {
  const heading = resolveHeading(altText, contents);
  const choices = contents === undefined ? [] : safeCollectChoiceLabels(contents, heading);
  const head = heading ? `[flex] ${heading}` : '[flex]';
  if (choices.length === 0) return head;
  return `${head}\n選択肢:\n${choices.map((c) => `- ${c}`).join('\n')}`;
}

/** 見出し (altText 優先・空なら本文先頭 text 救出)。 */
function resolveHeading(altText: unknown, contents: unknown): string {
  const fromAlt = typeof altText === 'string' ? altText.trim() : '';
  return fromAlt || (contents === undefined ? '' : safeExtractAltText(contents));
}

function safeExtractAltText(contents: unknown): string {
  try {
    const found = extractFlexAltText(contents);
    // extractFlexAltText は見つからないと 'お知らせ' を返す → 救出失敗扱いで空に倒す。
    return found && found !== 'お知らせ' ? found : '';
  } catch {
    return '';
  }
}

function safeCollectChoiceLabels(contents: unknown, heading: string): string[] {
  try {
    return collectChoiceLabels(contents, heading);
  } catch {
    return [];
  }
}

/**
 * Flex JSON 内の tap row / button のアクションラベルを抽出する。
 *
 * - tap row (TRYCLE buildTapRow) は box.action.label に選択肢ラベルを持つ
 * - LINE 標準 button は button.action.label を持つ
 * - URI / message / postback いずれの action でも label を拾う (datetimepicker は除く)
 *
 * 見出し (altText) と一致するラベルや重複ラベルは除外し、出現順を保つ。
 */
function collectChoiceLabels(contents: unknown, heading: string): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  if (heading) seen.add(heading.trim());

  const visit = (node: unknown, depth: number): void => {
    if (depth > FLEX_EXTRACT_MAX_DEPTH || !node || typeof node !== 'object') return;
    if (labels.length >= FLEX_MAX_CHOICE_LABELS) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    addActionLabel(obj.action, labels, seen);
    for (const key of ['header', 'hero', 'body', 'footer', 'contents']) {
      if (obj[key]) visit(obj[key], depth + 1);
    }
  };

  visit(contents, 0);
  return labels;
}

/** action オブジェクトの label を (重複でなければ) labels に積む。 */
function addActionLabel(action: unknown, labels: string[], seen: Set<string>): void {
  if (labels.length >= FLEX_MAX_CHOICE_LABELS) return;
  if (!action || typeof action !== 'object') return;
  const label = (action as Record<string, unknown>).label;
  if (typeof label !== 'string') return;
  const trimmed = label.trim();
  if (!trimmed || seen.has(trimmed)) return;
  seen.add(trimmed);
  labels.push(trimmed);
}

export function buildMessage(messageType: string, messageContent: string, altText?: string): Message {
  if (messageType === 'text') {
    return { type: 'text', text: messageContent };
  }

  if (messageType === 'image') {
    // messageContent is expected to be JSON: { originalContentUrl, previewImageUrl }
    try {
      const parsed = JSON.parse(messageContent) as {
        originalContentUrl: string;
        previewImageUrl: string;
      };
      return {
        type: 'image',
        originalContentUrl: parsed.originalContentUrl,
        previewImageUrl: parsed.previewImageUrl,
      };
    } catch {
      // Fallback: treat as text if parsing fails
      return { type: 'text', text: messageContent };
    }
  }

  if (messageType === 'flex') {
    try {
      const contents = JSON.parse(messageContent);
      // Remove empty text nodes (from {{#if_ref}} conditional blocks)
      cleanEmptyNodes(contents);
      // Extract first text element for altText (shown in notifications)
      return { type: 'flex', altText: altText || extractFlexAltText(contents), contents };
    } catch {
      return { type: 'text', text: messageContent };
    }
  }

  // Fallback
  return { type: 'text', text: messageContent };
}
