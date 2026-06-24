/**
 * TRYCLE「各種予約」3 分岐 + 来店予定ゲート (Phase 4)。
 *
 * リッチメニュー「各種予約」(`reservation_start`) を押すと 3 択を出し、
 *   - 洗車・ホイール試乗・フィッティング (`reservation_stores`)   → STORES リンク
 *   - メンテナンスの予約               (`reservation_maintenance`) → Pkg1 通常フロー
 *   - その他 (車体購入相談・初回相談)  (`reservation_visit_start`) → 来店予定ゲート
 * に分岐する。
 *
 * 来店予定ゲート (その他) は見積を伴わない純粋な来店予約:
 *   自由文 (任意・skip 可) → 店舗 (複数時) → 日付 → 時間 → 確認 → case 作成。
 * 日付/時間候補は Pkg1 来店予約と同じ営業時間ロジック (generateVisitDays /
 * validateVisitAt) を流用するが、postback prefix を `reservation_visit_*` に分け、
 * session も VISIT_GATE_KIND で Pkg1 来店予約 (RESERVATION_KIND) と分離する。
 *
 * Step ID 流入制御 (trycle-step.ts) は Pkg1 と同じく適用し、古ボタン/連打を silent に
 * 落とす。確定は claimVisitGateSession (DELETE … RETURNING) で原子的に 1 回化する。
 *
 * 仕様: Phase 4 (各種予約 3 分岐 + 来店予定ゲート・2026-06-24 user 承認)。
 */
import type { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../index.js';
import {
  findCustomerByLineUserId,
  findCustomerIdByLineUserId,
  findStoreById,
  findStoreDefaultAssigneeId,
  getStoresUrl,
  listActiveStores,
  type StoreRow,
  type TrycleRepoEnv,
} from './trycle-repo.js';
import {
  findCaseStatusByKey,
  findInitialCaseStatus,
  saveVisitOnlyCase,
} from './trycle-pkg1-repo.js';
import {
  getVisitGateSession,
  setVisitGateSession,
  clearVisitGateSession,
  claimVisitGateSession,
  type VisitGateState,
  type VisitGateStep,
} from './trycle-session.js';
import { appendChatSummary, flushChatSummaryBuffer } from './trycle-chat-summary.js';
import { evaluateStep, injectStepIntoMessages, parseStep } from './trycle-step.js';
import { jstWallToIsoZ, parseJstDatetime, validateVisitAt } from './trycle-store-hours.js';
import { generateVisitDays, nowJst, type VisitDay } from './trycle-visit-slots.js';
import { notifyStaff } from './trycle-staff.js';
import { recordOutgoingMessages } from './trycle-outgoing-log.js';
import { formatVisitAt } from './trycle-pkg1-flex.js';
import {
  reservationMenuPrompt,
  storesLinkPrompt,
  visitInquiryPrompt,
  visitStoreList,
  visitDateList,
  visitTimeList,
  visitConfirmPrompt,
  textMessage,
  type LineMessage,
} from './trycle-reservation-flex.js';

const MAX_REPLY_MESSAGES = 5;

/** 来店予定 case に付ける status key (dashboard 予約済・既存 case_statuses)。 */
const VISIT_CASE_STATUS_KEY = 'booked';
/** cases.work_note に残す経路の provenance (detail-view 用)。 */
const VISIT_CASE_LABEL = '来店予定 (各種予約)';
/** 自由文の最大保持長 (列肥大・暴走入力の防止)。 */
const MAX_INQUIRY_LENGTH = 200;

// ── 判定 / context ────────────────────────────────────────────────────────────

/** 各種予約 (reservation_*) の postback か判定する。 */
export function isReservationPostback(data: string): boolean {
  return parseAction(data).startsWith('reservation_');
}

export interface ReservationGateContext {
  readonly replyToken: string;
  readonly lineUserId: string;
  readonly lineClient: LineClient;
  readonly env: Env['Bindings'];
}

function repoEnv(ctx: ReservationGateContext): TrycleRepoEnv & { TRYCLE_STORES_URL?: string } {
  return ctx.env as TrycleRepoEnv & { TRYCLE_STORES_URL?: string };
}

function parseAction(data: string): string {
  if (!data.includes('action=')) return data;
  return new URLSearchParams(data).get('action') ?? '';
}

function parseValue(data: string): string | null {
  if (!data.includes('=')) return null;
  return new URLSearchParams(data).get('value');
}

/**
 * 各種予約 postback を捌く。handled=true なら caller は auto-reply に流さない。
 * `reservation_maintenance` は Pkg1 へ委譲が必要なため、ここでは扱わず false を返し、
 * dispatcher (trycle-postback.ts) が pkg1_start を発火する。
 */
export async function handleReservationGatePostback(
  data: string,
  ctx: ReservationGateContext,
): Promise<boolean> {
  if (!isReservationPostback(data)) return false;
  // メンテナンスは Pkg1 へ dispatcher が橋渡しする (ここでは未処理を返す)。
  if (parseAction(data) === 'reservation_maintenance') return false;

  console.log(
    '[trycle-reservation-gate] dispatch start',
    JSON.stringify({ data, lineUserId: ctx.lineUserId }),
  );
  try {
    await route(data, ctx);
    console.log('[trycle-reservation-gate] dispatch done', data);
  } catch (err) {
    console.error('[trycle-reservation-gate] handle failed', data, err);
    await safeReply(ctx, [
      textMessage('ご予約の処理に失敗しました。少し時間をおいて再度お試しください。'),
    ]);
  }
  return true;
}

async function route(data: string, ctx: ReservationGateContext): Promise<void> {
  const action = parseAction(data);
  const value = parseValue(data);

  // 入口系 (リッチメニュー・3 択タップ) は Step ID ゲートを通さない (いつ押しても
  // フローを再開してよい操作)。
  if (action === 'reservation_start') return showMenu(ctx);
  if (action === 'reservation_stores') return showStoresLink(ctx);
  if (action === 'reservation_visit_start') return startVisitGate(ctx);
  if (action === 'reservation_visit_skip') return onInquirySkip(ctx);

  // 来店予定ゲートのフロー postback は Step ID ゲートで古ボタン/連打を制御する。
  const gate = await evaluateGateStep(data, action, ctx);
  if (gate === 'stale') {
    console.log(
      '[trycle-reservation-gate] stale step → silent no-op',
      JSON.stringify({ action, step: parseStep(data) }),
    );
    return;
  }

  switch (action) {
    case 'reservation_visit_store':
      return onStoreSelected(ctx, value);
    case 'reservation_visit_date':
      return onDateSelected(ctx, value);
    case 'reservation_visit_time':
      return onTimeSelected(ctx, value);
    case 'reservation_visit_confirm':
      return onConfirm(ctx, value);
    default:
      return; // 未知 reservation_ postback は黙って無視。
  }
}

// ── Step ID 流入制御 ─────────────────────────────────────────────────────────

const VISIT_ACTION_STEP: Readonly<Record<string, VisitGateStep>> = {
  reservation_visit_store: 'awaiting_store',
  reservation_visit_date: 'awaiting_date',
  reservation_visit_time: 'awaiting_time',
  reservation_visit_confirm: 'awaiting_confirm',
};

async function evaluateGateStep(
  data: string,
  action: string,
  ctx: ReservationGateContext,
): Promise<'advance' | 'rollback' | 'stale' | 'pass'> {
  const expected = VISIT_ACTION_STEP[action];
  if (!expected) return 'pass';
  const received = parseStep(data);
  const session = await getVisitGateSession(repoEnv(ctx), ctx.lineUserId).catch(() => null);
  const current = session?.step ?? null;
  const previous = session?.previousStep ?? null;
  if (received === null) {
    // 旧 Flex (step 未埋め込み): session 無しは新規 tap かもしれないので handler に委ねる。
    if (current === null) return 'advance';
    return current === expected ? 'advance' : 'stale';
  }
  return evaluateStep(received, current, previous);
}

/** visit gate session を次 step へ進めた新 state を返す (previousStep を退避・immutable)。 */
function advanceVisit(
  session: VisitGateState,
  nextStep: VisitGateStep,
  patch: Partial<VisitGateState> = {},
): VisitGateState {
  return { ...session, previousStep: session.step, step: nextStep, ...patch };
}

// ── ① 各種予約 3 択 ────────────────────────────────────────────────────────────

async function showMenu(ctx: ReservationGateContext): Promise<void> {
  // 入口に戻る = ゲート進行中の state があれば破棄して作り直しを許す。
  await clearVisitGateSession(repoEnv(ctx), ctx.lineUserId).catch((err) =>
    console.error('[trycle-reservation-gate] showMenu clear failed', err),
  );
  await safeReply(ctx, [reservationMenuPrompt()]);
}

// ── ② 洗車・試乗・フィッティング → STORES ────────────────────────────────────

async function showStoresLink(ctx: ReservationGateContext): Promise<void> {
  const storesUrl = await getStoresUrl(repoEnv(ctx)).catch((err) => {
    console.error('[trycle-reservation-gate] getStoresUrl failed', err);
    return null;
  });
  await safeReply(ctx, [storesLinkPrompt(storesUrl ?? undefined)]);
}

// ── ④ その他 → 来店予定ゲート ─────────────────────────────────────────────────

async function startVisitGate(ctx: ReservationGateContext): Promise<void> {
  await setVisitGateSession(repoEnv(ctx), ctx.lineUserId, { step: 'awaiting_inquiry' }).catch(
    (err) => console.error('[trycle-reservation-gate] startVisitGate set failed', err),
  );
  // 起票 (新フロー)。後続イベントで同じ flow_id を共有する。
  await appendChatSummary(repoEnv(ctx), ctx.lineUserId, {
    flowType: 'inquiry',
    speaker: '顧客',
    text: '来店予約 (各種予約) を開始',
    startNewFlow: true,
  });
  await safeReply(ctx, [visitInquiryPrompt()]);
}

/**
 * 自由文入力を受ける (webhook の text 経路から呼ばれる)。awaiting_inquiry でなければ
 * false を返し、caller は通常の text 処理 (Pkg1 qty / Pkg8 FAQ) へ流す。
 */
export async function handleReservationGateText(
  text: string,
  ctx: ReservationGateContext,
): Promise<boolean> {
  const env = repoEnv(ctx);
  const session = await getVisitGateSession(env, ctx.lineUserId).catch(() => null);
  if (!session || session.step !== 'awaiting_inquiry') return false;

  const inquiry = text.trim().slice(0, MAX_INQUIRY_LENGTH);
  await appendChatSummary(env, ctx.lineUserId, {
    flowType: 'inquiry',
    speaker: '顧客',
    text: `ご相談内容: ${inquiry}`,
  });
  await proceedToStoreOrDate(ctx, session, inquiry);
  return true;
}

async function onInquirySkip(ctx: ReservationGateContext): Promise<void> {
  const env = repoEnv(ctx);
  const session = await getVisitGateSession(env, ctx.lineUserId).catch(() => null);
  if (!session || session.step !== 'awaiting_inquiry') {
    // 入口から外れている (失効) → ゲートを作り直す。
    return restartGate(ctx, 'ご来店予約をもう一度はじめからお願いします。');
  }
  await proceedToStoreOrDate(ctx, session, undefined);
}

/**
 * 自由文 (or skip) 後の遷移: 店舗が複数なら店舗選択、1 店舗なら自動選択して日付へ。
 */
async function proceedToStoreOrDate(
  ctx: ReservationGateContext,
  session: VisitGateState,
  inquiry: string | undefined,
): Promise<void> {
  const env = repoEnv(ctx);
  const stores = await listActiveStores(env).catch((err) => {
    console.error('[trycle-reservation-gate] listActiveStores failed', err);
    return [] as StoreRow[];
  });
  if (stores.length === 0) {
    await clearVisitGateSession(env, ctx.lineUserId).catch(() => undefined);
    await safeReply(ctx, [
      textMessage('ご予約の準備でエラーが発生しました。スタッフが折り返します。'),
    ]);
    return;
  }

  const withInquiry: Partial<VisitGateState> = { inquiry };

  if (stores.length === 1) {
    const store = stores[0]!;
    await setVisitGateSession(
      env,
      ctx.lineUserId,
      advanceVisit(session, 'awaiting_date', {
        ...withInquiry,
        storeId: store.id,
        storeName: store.name,
      }),
    );
    await safeReply(
      ctx,
      [visitDateList(store, generateVisitDays(store, nowJst()))],
      'awaiting_date',
    );
    return;
  }

  await setVisitGateSession(env, ctx.lineUserId, advanceVisit(session, 'awaiting_store', withInquiry));
  await safeReply(
    ctx,
    [textMessage('ご来店店舗をお選びください。'), visitStoreList(stores)],
    'awaiting_store',
  );
}

// ── 店舗選択 → 日付 ────────────────────────────────────────────────────────────

async function onStoreSelected(ctx: ReservationGateContext, storeId: string | null): Promise<void> {
  const env = repoEnv(ctx);
  if (!storeId) return gateLost(ctx);
  const session = await getVisitGateSession(env, ctx.lineUserId);
  if (!session) return gateLost(ctx);
  const store = await findStoreById(env, storeId);
  if (!store) return gateLost(ctx);

  await setVisitGateSession(
    env,
    ctx.lineUserId,
    advanceVisit(session, 'awaiting_date', {
      storeId: store.id,
      storeName: store.name,
      date: undefined,
      visitAtIso: undefined,
    }),
  );
  await safeReply(ctx, [visitDateList(store, generateVisitDays(store, nowJst()))], 'awaiting_date');
}

// ── 日付選択 → 時間 ────────────────────────────────────────────────────────────

async function onDateSelected(ctx: ReservationGateContext, date: string | null): Promise<void> {
  const env = repoEnv(ctx);
  if (!date) return gateLost(ctx);
  const session = await getVisitGateSession(env, ctx.lineUserId);
  if (!session?.storeId) return gateLost(ctx);
  const store = await findStoreById(env, session.storeId);
  if (!store) return gateLost(ctx);

  const day = findVisitDay(store, date);
  if (!day || day.slots.length === 0) {
    await safeReply(
      ctx,
      [textMessage('恐れ入りますが、別の日をお選びください。'), visitDateList(store, generateVisitDays(store, nowJst()))],
      'awaiting_date',
    );
    return;
  }

  await setVisitGateSession(
    env,
    ctx.lineUserId,
    advanceVisit(session, 'awaiting_time', { date, visitAtIso: undefined }),
  );
  await safeReply(ctx, [visitTimeList(store, day)], 'awaiting_time');
}

// ── 時間選択 → 確認 ────────────────────────────────────────────────────────────

async function onTimeSelected(ctx: ReservationGateContext, datetime: string | null): Promise<void> {
  const env = repoEnv(ctx);
  if (!datetime) return gateLost(ctx);
  const session = await getVisitGateSession(env, ctx.lineUserId);
  if (!session?.storeId) return gateLost(ctx);
  const store = await findStoreById(env, session.storeId);
  if (!store) return gateLost(ctx);

  // 候補から出た値だが stale タップ対策で営業時間 / grid を再検証する。
  const visitAt = parseJstDatetime(datetime);
  if (!visitAt || !validateVisitAt(store, visitAt).ok) {
    await reofferTimeOrDate(ctx, store, session.date ?? null, '恐れ入りますが、別の時間をお選びください。');
    return;
  }

  await setVisitGateSession(
    env,
    ctx.lineUserId,
    advanceVisit(session, 'awaiting_confirm', { storeName: store.name, visitAtIso: datetime }),
  );
  await safeReply(
    ctx,
    [visitConfirmPrompt(store.name, datetime, session.inquiry ?? null)],
    'awaiting_confirm',
  );
}

/** 時間選択へ戻れるなら戻し、日付が失われていれば日付選択へ倒す (無反応を防ぐ)。 */
async function reofferTimeOrDate(
  ctx: ReservationGateContext,
  store: StoreRow,
  date: string | null,
  lead: string,
): Promise<void> {
  const day = date ? findVisitDay(store, date) : null;
  if (day && day.slots.length > 0) {
    await safeReply(ctx, [textMessage(lead), visitTimeList(store, day)], 'awaiting_time');
    return;
  }
  await safeReply(
    ctx,
    [textMessage(lead), visitDateList(store, generateVisitDays(store, nowJst()))],
    'awaiting_date',
  );
}

function findVisitDay(store: StoreRow, date: string): VisitDay | null {
  return generateVisitDays(store, nowJst()).find((d) => d.date === date) ?? null;
}

// ── 確認 → case 作成 / 日時変更 ────────────────────────────────────────────────

async function onConfirm(ctx: ReservationGateContext, value: string | null): Promise<void> {
  const env = repoEnv(ctx);

  if (value === 'change') {
    // 「日時を変更する」= 日付からやり直す (Pkg1 来店予約と同仕様・2026-06-24)。
    const session = await getVisitGateSession(env, ctx.lineUserId);
    if (!session) return gateLost(ctx);
    const store = session.storeId ? await findStoreById(env, session.storeId) : null;
    if (!store) return gateLost(ctx);
    await setVisitGateSession(
      env,
      ctx.lineUserId,
      advanceVisit(session, 'awaiting_date', { visitAtIso: undefined, date: undefined }),
    );
    await reofferTimeOrDate(ctx, store, null, '別の日付をお選びください。');
    return;
  }
  if (value !== 'ok') return;

  // 確定の二重実行防止: 連打 / webhook retry で case が 2 件作られるのを防ぐため、
  // session を原子的に claim (DELETE … RETURNING) し、行を受け取れた request だけが
  // finalize する。空 claim = 既に確定済み / 失効 → silent (無反応防止より重複防止優先)。
  const claimed = await claimVisitGateSession(env, ctx.lineUserId).catch((err) => {
    console.error('[trycle-reservation-gate] claimVisitGateSession failed', err);
    return null;
  });
  if (!claimed) {
    console.log('[trycle-reservation-gate] confirm duplicate / expired → silent', ctx.lineUserId);
    return;
  }
  if (!claimed.visitAtIso || !claimed.storeId) {
    // 不整合 (日時 / 店舗欠落) → 作り直し導線。
    return restartGate(ctx, 'ご来店予約をもう一度はじめからお願いします。');
  }
  await finalizeVisitGate(ctx, claimed);
}

/** 来店予約確定 → cases 1 件作成 → スタッフ通知 → 完了 reply。 */
async function finalizeVisitGate(ctx: ReservationGateContext, session: VisitGateState): Promise<void> {
  const env = repoEnv(ctx);
  const visitAtIso = session.visitAtIso ?? null;
  const visitAtIsoForDb = visitAtIso ? jstWallToIsoZ(visitAtIso) : null;
  const inquiry = session.inquiry ?? null;

  // 来店予約成立イベントを履歴へ (case 作成前に buffer へ積み、flush で case に移す)。
  await appendChatSummary(env, ctx.lineUserId, {
    flowType: 'inquiry',
    speaker: 'bot',
    text: visitAtIso
      ? `来店予約: ${session.storeName ?? '店舗'} ${formatVisitAt(visitAtIso)}`
      : `来店予約: ${session.storeName ?? '店舗'}`,
  });

  const status =
    (await findCaseStatusByKey(env, VISIT_CASE_STATUS_KEY).catch(() => null)) ??
    (await findInitialCaseStatus(env).catch(() => null));
  if (!status) {
    console.error('[trycle-reservation-gate] no case_statuses; cannot save visit case');
    await safeReply(ctx, [
      textMessage('ご予約の保存でエラーが発生しました。スタッフが折り返しご連絡いたします。'),
    ]);
    return;
  }

  const customerId = await findCustomerIdByLineUserId(env, ctx.lineUserId).catch(() => null);
  const assigneeId = session.storeId
    ? await findStoreDefaultAssigneeId(env, session.storeId)
    : null;

  let caseId: string | null = null;
  try {
    const saved = await saveVisitOnlyCase(env, {
      lineUserId: ctx.lineUserId,
      customerId,
      storeId: session.storeId ?? null,
      statusId: status.id,
      assigneeId,
      visitScheduledAt: visitAtIsoForDb,
      caseLabel: VISIT_CASE_LABEL,
      chatSummary: null,
    });
    caseId = saved.caseId;
    // buffer 行を新 case へ移す (起票/相談内容/予約成立を 1 カードにまとめる)。
    await flushChatSummaryBuffer(env, ctx.lineUserId, caseId).catch((err) =>
      console.error('[trycle-reservation-gate] flushChatSummaryBuffer failed', err),
    );
  } catch (err) {
    console.error('[trycle-reservation-gate] saveVisitOnlyCase failed', err);
    await safeReply(ctx, [
      textMessage('ご予約の保存でエラーが発生しました。スタッフが折り返しご連絡いたします。'),
    ]);
    return;
  }

  // スタッフへ Gmail 通知 (来店予定の受付・相談内容を inquiryText で店舗振り分けに使う)。
  const customer = await findCustomerByLineUserId(env, ctx.lineUserId).catch(() => null);
  await notifyStaff(ctx.env, {
    lineUserId: ctx.lineUserId,
    customerName: customer?.name ?? null,
    reason: '来店予定の受付',
    estimateSummary: null,
    pdfUrl: null,
    note: visitAtIso
      ? `来店予定: ${formatVisitAt(visitAtIso)}${inquiry ? ` / ご相談: ${inquiry}` : ''}`
      : null,
    inquiryText: inquiry ?? undefined,
  }).catch((err) => console.error('[trycle-reservation-gate] notifyStaff failed', err));

  await appendChatSummary(env, ctx.lineUserId, {
    flowType: 'inquiry',
    speaker: 'bot',
    text: 'スタッフ引継: 来店予定の受付',
  });

  const visitLabel = visitAtIso ? formatVisitAt(visitAtIso) : '';
  await safeReply(ctx, [
    textMessage(
      `ご予約を承りました。${session.storeName ?? '店舗'}にて${visitLabel}にお待ちしております。`,
    ),
  ]);
}

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * ゲート session が失効 / 不整合のときの graceful フォールバック。タップしても無反応を
 * 防ぐため、3 択メニューを作り直して再開導線を返す。
 */
async function gateLost(ctx: ReservationGateContext): Promise<void> {
  await restartGate(
    ctx,
    'ご来店予約の受付が一度リセットされました。\nお手数ですが、もう一度お選びください。',
  );
}

/** ゲートを破棄して 3 択メニューを (lead 付きで) 再提示する。 */
async function restartGate(ctx: ReservationGateContext, lead: string): Promise<void> {
  await clearVisitGateSession(repoEnv(ctx), ctx.lineUserId).catch((err) =>
    console.error('[trycle-reservation-gate] restartGate clear failed', err),
  );
  await safeReply(ctx, [textMessage(lead), reservationMenuPrompt()]);
}

/**
 * reply を送る。`step` を渡すと、その reply に含まれる全 postback の data へ Step ID を
 * 埋め込む (Step ID 流入制御)。終端メッセージ (確定後など) では step を渡さない。
 */
async function safeReply(
  ctx: ReservationGateContext,
  messages: LineMessage[],
  step?: VisitGateStep,
): Promise<void> {
  const stamped = step ? injectStepIntoMessages(messages, step) : messages;
  const sent = stamped.slice(0, MAX_REPLY_MESSAGES);
  try {
    await ctx.lineClient.replyMessage(ctx.replyToken, sent as never);
  } catch (err) {
    console.error('[trycle-reservation-gate] reply failed', err);
    return;
  }
  await recordOutgoingMessages(ctx.env, ctx.lineUserId, sent, 'reply', 'pkg1');
}
