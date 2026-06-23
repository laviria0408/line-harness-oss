/**
 * TRYCLE Pkg1「整備見積もり」postback dispatcher (本物モデル・経路 A〜E)。
 *
 *   経路 A  入口 + 状況ふりわけ 3 択 (identified→見積 / 包括・不明→スタッフ送り)
 *   経路 B  症状ヒアリング region → symptom → variant → qty → cart
 *   経路 C  カート確定 → 概算見積 → 確認 3 択 (PDF だけ / 来店予定 / やり直す)
 *   経路 D  D-1 pdf_only (PDF 発行) / D-2 来店予定 (同意書 → 日時候補 縦リスト・Option A)
 *   経路 E  来店時補完 (pkg1_wage → 同意書単体提出 LIFF・consent-callback 側で紐付け)
 *
 * 本物 trycle-line-harness/src/flows/pkg1-estimate.ts + reservation-flow.ts を
 * Cloudflare Workers + Hono + Supabase REST に port。session は Supabase
 * bot_sessions (kind=pkg1_estimate / pkg1_cart / reservation)。
 *
 * 設計: Pkg1 詳細設計 v1.2.1 (page 386050ad6a7e81f8b701cd52c9201af6)。
 */
import type { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../index.js';
import { REGIONS, findRegionByValue, type Region, type Symptom } from '../data/pkg1-regions.js';
import {
  buildQuote,
  formatQuoteText,
  makeLineItem,
  type Quote,
  type QuoteLineItem,
} from './quote.js';
import {
  findCustomerByLineUserId,
  findCustomerIdByLineUserId,
  hasValidMaintenanceConsent,
  listActiveStores,
  findStoreById,
  getTenantQuoteSettings,
  type TrycleRepoEnv,
} from './trycle-repo.js';
import {
  buildLineItemFromPending,
  findCaseStatusByKey,
  findInitialCaseStatus,
  findDefaultStore,
  findStoreCode,
  saveQuote,
  updateQuotePdfUrl,
  type SavedQuote,
} from './trycle-pkg1-repo.js';
import {
  getPkg1Session,
  upsertPkg1Session,
  clearPkg1Session,
  setPkg1Cart,
  getPkg1Cart,
  clearPkg1Cart,
  getReservationSession,
  setReservationSession,
  clearReservationSession,
  setManualMode,
  emptyPkg1State,
  cartSubtotal,
  type Pkg1State,
  type PendingSelection,
  type ReservationState,
} from './trycle-session.js';
import { jstWallToIsoZ, parseJstDatetime, validateVisitAt } from './trycle-store-hours.js';
import { generateVisitDays, nowJst, type VisitDay } from './trycle-visit-slots.js';
import { notifyStaff } from './trycle-staff.js';
import { appendChatSummary, flushChatSummaryBuffer } from './trycle-chat-summary.js';
import { issueEstimatePdf, type EstimatePdfResult } from './trycle-pkg1-pdf.js';
import {
  dispatchPrompt,
  regionMessages,
  symptomMessages,
  variantMessages,
  qtyPrompt,
  cartDecisionPrompt,
  confirmMessages,
  consentPrompt,
  cartSummaryText,
  reservationStoreCarousel,
  reservationDateList,
  reservationTimeList,
  reservationConfirmPrompt,
  textMessage,
  formatVisitAt,
  DISPATCH_LABELS,
  MAX_REPLY_MESSAGES,
  type Dispatch,
  type LineMessage,
} from './trycle-pkg1-flex.js';

// ── postback 判定 ─────────────────────────────────────────────────────────────

/**
 * Pkg1 postback か判定する。本物 router.ts の prefix 振り分けに相当。
 *   - 入口/メニュー: 素の `pkg1_start` / `pkg1_wage`
 *   - フロー本体:    `action=pkg1_X&value=Y` / `action=pkg1_reserve_*`
 */
export function isPkg1Postback(data: string): boolean {
  if (data === 'pkg1_start' || data === 'pkg1_wage') return true;
  const action = parseAction(data);
  return action.startsWith('pkg1_');
}

function parseAction(data: string): string {
  if (!data.includes('action=')) return data;
  return new URLSearchParams(data).get('action') ?? '';
}

function parseValue(data: string): string | null {
  if (!data.includes('=')) return null;
  return new URLSearchParams(data).get('value');
}

// ── context ──────────────────────────────────────────────────────────────────

export interface Pkg1Context {
  readonly replyToken: string;
  readonly lineUserId: string;
  readonly lineClient: LineClient;
  readonly env: Env['Bindings'];
  /** datetimepicker の選択値 (postback.params.datetime)。来店予定の日時受け取り用。 */
  readonly datetime?: string;
}

function repoEnv(ctx: Pkg1Context): TrycleRepoEnv {
  return ctx.env as TrycleRepoEnv;
}

/**
 * Pkg1 postback を捌く。handled=true なら caller は auto-reply に流さない。
 */
export async function handlePkg1Postback(data: string, ctx: Pkg1Context): Promise<boolean> {
  if (!isPkg1Postback(data)) return false;
  console.log('[trycle-pkg1] dispatch start', JSON.stringify({ data, lineUserId: ctx.lineUserId }));
  try {
    await route(data, ctx);
    console.log('[trycle-pkg1] dispatch done', data);
  } catch (err) {
    console.error('[trycle-pkg1] handle failed', data, err);
    await safeReply(ctx, [
      textMessage('見積もりの処理に失敗しました。少し時間をおいて再度お試しください。'),
    ]);
  }
  return true;
}

async function route(data: string, ctx: Pkg1Context): Promise<void> {
  const action = parseAction(data);
  const value = parseValue(data);

  // 入口 / メニュー (素の postback)
  if (action === 'pkg1_start') return startFlow(ctx);
  if (action === 'pkg1_wage') return startConsentLiff(ctx);

  // 来店予定フロー (本物 handleReservationPostback に委譲相当)
  if (action.startsWith('pkg1_reserve_')) return handleReservationPostback(action, value, ctx);

  switch (action) {
    case 'pkg1_dispatch':
      return onDispatch(ctx, value);
    case 'pkg1_region':
      return onRegion(ctx, value);
    case 'pkg1_symptom':
      return onSymptom(ctx, value);
    case 'pkg1_variant':
      return onVariant(ctx, value);
    case 'pkg1_qty':
      return onQty(ctx, value);
    case 'pkg1_cart':
      return onCartDecision(ctx, value);
    case 'pkg1_confirm':
      return onConfirm(ctx, value);
    default:
      return; // 未知の pkg1_ postback は黙って無視 (本物 default 準拠)
  }
}

// ── ① 開始 → 状況ふりわけ (REQ-PKG1-002) ──────────────────────────────────────

async function startFlow(ctx: Pkg1Context): Promise<void> {
  await upsertPkg1Session(repoEnv(ctx), ctx.lineUserId, emptyPkg1State()).catch((err) =>
    console.error('[trycle-pkg1] startFlow upsertPkg1Session failed', err),
  );
  // 案件起票 (フロー開始)。新 flow_id を採番し後続イベントで共有される。
  await appendChatSummary(repoEnv(ctx), ctx.lineUserId, {
    flowType: 'pkg1',
    speaker: '顧客',
    text: '整備見積を依頼',
    startNewFlow: true,
  });
  await safeReply(ctx, [dispatchPrompt()]);
}

async function onDispatch(ctx: Pkg1Context, value: string | null): Promise<void> {
  const dispatch = parseDispatch(value);
  if (!dispatch) return;

  // 包括メンテ・原因わからない → スタッフ相談誘導をもって完成 (本物 onDispatch)。
  if (dispatch !== 'identified') {
    await clearPkg1Session(repoEnv(ctx), ctx.lineUserId).catch((err) => console.error('[trycle-pkg1] clearPkg1Session failed', err));
    await escalate(
      ctx,
      DISPATCH_LABELS[dispatch],
      `「${DISPATCH_LABELS[dispatch]}」ですね。こちらは現物確認が必要なため、スタッフがご相談を承ります。`,
    );
    return;
  }

  await upsertPkg1Session(repoEnv(ctx), ctx.lineUserId, {
    ...(await currentSession(ctx)),
    step: 'awaiting_region',
    pending: undefined,
  });
  await safeReply(ctx, regionMessages(REGIONS));
}

// ── ② 部位選択 (REQ-PKG1-004) ─────────────────────────────────────────────────

async function onRegion(ctx: Pkg1Context, value: string | null): Promise<void> {
  const region = value ? findRegionByValue(value) : undefined;
  if (!region) {
    await safeReply(ctx, regionMessages(REGIONS));
    return;
  }
  // 「その他（自由記述）」はスタッフ送り (REQ-PKG1-018)。選択した部位ラベルを
  // 種別タグ判定 (Add-D) の起点に渡す。
  if (region.symptoms === null) {
    return finishWithEscalation(ctx, region.label);
  }
  const session = await currentSession(ctx);
  await upsertPkg1Session(repoEnv(ctx), ctx.lineUserId, {
    ...session,
    step: 'awaiting_symptom',
    pending: { regionValue: region.value, symptomIndex: -1 },
  });
  await safeReply(ctx, symptomMessages(region));
}

// ── ③ 作業選択 (REQ-PKG1-005) ─────────────────────────────────────────────────

async function onSymptom(ctx: Pkg1Context, value: string | null): Promise<void> {
  const session = await currentSession(ctx);
  if (!session.pending) return startFlow(ctx);
  const region = findRegionByValue(session.pending.regionValue);
  const symptomIndex = value ? Number.parseInt(value, 10) : NaN;
  const symptom = region?.symptoms?.[symptomIndex];
  if (!region || !symptom) {
    await safeReply(ctx, region ? symptomMessages(region) : regionMessages(REGIONS));
    return;
  }
  const pending: PendingSelection = { ...session.pending, symptomIndex };

  // variants があれば種類を選ばせる。
  if (symptom.variants && symptom.variants.length > 0) {
    await upsertPkg1Session(repoEnv(ctx), ctx.lineUserId, {
      ...session,
      step: 'awaiting_variant',
      pending,
    });
    await safeReply(ctx, variantMessages(symptom));
    return;
  }
  // sample=null (「その他」) は確定額を出さずスタッフ送り (REQ-PKG1-018)。
  // 部位+作業ラベルを種別タグ判定 (Add-D) の起点に渡す。
  if (!symptom.sample) {
    return finishWithEscalation(ctx, `${region.label} ${symptom.label}`);
  }
  return resolveAfterSelection(ctx, session, symptom, pending);
}

// ── 種類選択 (variant) ────────────────────────────────────────────────────────

async function onVariant(ctx: Pkg1Context, value: string | null): Promise<void> {
  const session = await currentSession(ctx);
  if (!session.pending) return startFlow(ctx);
  const region = findRegionByValue(session.pending.regionValue);
  const symptom = region?.symptoms?.[session.pending.symptomIndex];
  const variantIndex = value ? Number.parseInt(value, 10) : NaN;
  const variant = symptom?.variants?.[variantIndex];
  if (!region || !symptom || !variant) {
    if (symptom) await safeReply(ctx, variantMessages(symptom));
    return;
  }
  if (!variant.sample) {
    return finishWithEscalation(ctx, `${region.label} ${symptom.label} ${variant.label}`);
  }
  const pending: PendingSelection = { ...session.pending, variantIndex };
  return resolveAfterSelection(ctx, session, symptom, pending);
}

/** variant 確定後の共通処理: 数量が要るか確認し、不要なら明細追加。 */
async function resolveAfterSelection(
  ctx: Pkg1Context,
  session: Pkg1State,
  symptom: Symptom,
  pending: PendingSelection,
): Promise<void> {
  if (symptom.qty) {
    await upsertPkg1Session(repoEnv(ctx), ctx.lineUserId, {
      ...session,
      step: 'awaiting_qty',
      pending,
    });
    await safeReply(ctx, [qtyPrompt(symptom)]);
    return;
  }
  return addLineItemAndAskCart(ctx, { ...session, pending }, 1);
}

// ── 数量選択 (v1.2.1: 制限なし・任意数量 OK) ──────────────────────────────────

async function onQty(ctx: Pkg1Context, value: string | null): Promise<void> {
  const session = await currentSession(ctx);
  if (!session.pending) return startFlow(ctx);
  const symptom = currentSymptom(session.pending);
  if (!symptom) return startFlow(ctx);

  // v1.2.1: 3 本以上のスタッフ送りは廃止。任意数量を通常 cart に積む。
  const qty = value ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(qty) || qty < 1) {
    await safeReply(ctx, [qtyPrompt(symptom)]);
    return;
  }
  return addLineItemAndAskCart(ctx, session, qty);
}

/**
 * 数量ステップで自由入力 (text) が来たときに任意数量を受ける (v1.2.1)。
 * webhook の text 経路から呼ばれる。awaiting_qty でなければ false を返す。
 */
export async function handlePkg1Text(text: string, ctx: Pkg1Context): Promise<boolean> {
  const session = await getPkg1Session(repoEnv(ctx), ctx.lineUserId).catch(() => null);
  if (!session || session.step !== 'awaiting_qty' || !session.pending) return false;
  const symptom = currentSymptom(session.pending);
  if (!symptom) return false;
  const qty = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(qty) || qty < 1) {
    await safeReply(ctx, [
      textMessage('本数を半角数字でお送りください（例: 3）。'),
      qtyPrompt(symptom),
    ]);
    return true;
  }
  await addLineItemAndAskCart(ctx, session, qty);
  return true;
}

// ── 明細をカートへ追加 → 追加 or 確認へ (REQ-PKG1-008 / 021) ───────────────────

async function addLineItemAndAskCart(
  ctx: Pkg1Context,
  session: Pkg1State,
  qty: number,
): Promise<void> {
  const base = await buildLineItemFromPending(repoEnv(ctx), session.pending);
  if (!base) return finishWithEscalation(ctx, pendingLabel(session.pending));

  const item = makeLineItem({
    name: base.name,
    unitPrice: base.unitPrice,
    unitPriceMax: base.unitPriceMax,
    qty,
    ...(base.notes ? { notes: base.notes } : {}),
  });
  const cart = [...session.cart, item];

  // メニュー選択確定 (region/symptom/variant 合算で 1 行)。item.name に部位+作業+種類が
  // 含まれる (例「ブレーキパッド交換（前後）」)。qty>1 のときは本数も付す。
  await appendChatSummary(repoEnv(ctx), ctx.lineUserId, {
    flowType: 'pkg1',
    speaker: '顧客',
    text: qty > 1 ? `${item.name} ×${qty}` : item.name,
  });

  await upsertPkg1Session(repoEnv(ctx), ctx.lineUserId, {
    ...session,
    cart,
    step: 'awaiting_cart_decision',
    pending: undefined,
  });
  const taxOptions = await getTenantQuoteSettings(repoEnv(ctx));
  await safeReply(ctx, [textMessage(cartSummaryText(cart, taxOptions)), cartDecisionPrompt()]);
}

async function onCartDecision(ctx: Pkg1Context, value: string | null): Promise<void> {
  const session = await currentSession(ctx);
  if (value === 'add') {
    await upsertPkg1Session(repoEnv(ctx), ctx.lineUserId, { ...session, step: 'awaiting_region' });
    await safeReply(ctx, regionMessages(REGIONS));
    return;
  }
  // 'confirm'
  if (session.cart.length === 0) {
    await safeReply(ctx, regionMessages(REGIONS));
    return;
  }
  await upsertPkg1Session(repoEnv(ctx), ctx.lineUserId, { ...session, step: 'awaiting_confirm' });
  const taxOptions = await getTenantQuoteSettings(repoEnv(ctx));
  await safeReply(ctx, confirmMessages(session.cart, taxOptions));
}

// ── 確認 → 3 択 (REQ-PKG1-009/011) ────────────────────────────────────────────

async function onConfirm(ctx: Pkg1Context, value: string | null): Promise<void> {
  const session = await currentSession(ctx);

  if (value === 'redo') {
    await upsertPkg1Session(repoEnv(ctx), ctx.lineUserId, {
      ...session,
      cart: [],
      step: 'awaiting_region',
      pending: undefined,
    });
    await safeReply(ctx, [
      textMessage('承知しました。あらためてご希望の整備をお選びください。'),
      ...regionMessages(REGIONS),
    ]);
    return;
  }
  if (value === 'pdf_only') return finishPdfOnly(ctx, session);
  if (value === 'reserve') return enterReservation(ctx, session);
}

// ── 経路 D-1: pdf_only (連絡先・同意書スキップ・cases + quote_versions 保存) ────

async function finishPdfOnly(ctx: Pkg1Context, session: Pkg1State): Promise<void> {
  if (session.cart.length === 0) {
    await safeReply(ctx, [textMessage('見積もりたい整備メニューを先にお選びください。'), dispatchPrompt()]);
    return;
  }
  const env = repoEnv(ctx);
  const quote = buildQuote(session.cart, await getTenantQuoteSettings(env));

  // 見積成立 (概算)。case 生成前に append → 同一 flow_id でバッファに積み、
  // saveQuote 直後の flush で起票/選択行と一緒に case へ移す (グルーピング維持)。
  await appendChatSummary(env, ctx.lineUserId, {
    flowType: 'pkg1',
    speaker: 'bot',
    text: `概算見積 ¥${quote.total.toLocaleString('ja-JP')}`,
  });

  // 見積保存 (v1.2.1 §7 #3): cases(status pdf_only・customer_id=null) + quote_versions。
  // saveQuoteSafely 内で flushChatSummaryBuffer がバッファを case へ移す。
  const saved = await saveQuoteSafely(ctx, {
    quote,
    customerId: null,
    visitScheduledAt: null,
    caseLabel: 'pdf_only',
    statusKey: 'quote',
  });

  // PDF 発行 (payload に line_user_id 含む・v1.2.1)。失敗してもフローは止めない。
  const customer = await resolveCustomerContact(ctx);
  const pdf = await issueEstimatePdf(ctx.env, {
    quote,
    customerName: customer.name,
    customerPhone: customer.phone,
    storeName: null,
    quoteNo: saved?.quoteNo ?? null,
    lineUserId: ctx.lineUserId,
  });
  const pdfUrl = resolvePdfUrl(pdf, 'pdf_only', ctx.lineUserId);
  if (saved && pdfUrl) await updateQuotePdfUrl(env, saved, pdfUrl).catch((err) => console.error('[trycle-pkg1] updateQuotePdfUrl failed', err));

  await clearPkg1Session(env, ctx.lineUserId).catch((err) => console.error('[trycle-pkg1] clearPkg1Session failed', err));

  await safeReply(ctx, [
    textMessage(formatQuoteWithPdf(quote, pdfUrl)),
    textMessage('またのお問い合わせをお待ちしております。'),
  ]);
}

// ── 経路 D-2: 来店予定 — 同意書ゲート (来店予定押下直後・本物 enterReservation) ──

async function enterReservation(ctx: Pkg1Context, session: Pkg1State): Promise<void> {
  if (session.cart.length === 0) {
    await safeReply(ctx, [textMessage('見積もりたい整備メニューを先にお選びください。'), dispatchPrompt()]);
    return;
  }
  const env = repoEnv(ctx);

  let consentValid = false;
  try {
    consentValid = await hasValidMaintenanceConsent(env, ctx.lineUserId);
  } catch (err) {
    console.warn('[trycle-pkg1] consent check failed (treat as not consented):', err);
  }

  if (consentValid) {
    await clearPkg1Session(env, ctx.lineUserId).catch((err) => console.error('[trycle-pkg1] clearPkg1Session failed', err));
    return startReservationFlow(ctx, session.cart);
  }

  // 未同意 → cart を退避 (consent-callback で復帰) → 同意書を提示。
  await setPkg1Cart(env, ctx.lineUserId, session.cart).catch((err) => console.error('[trycle-pkg1] setPkg1Cart failed', err));
  await upsertPkg1Session(env, ctx.lineUserId, { ...session, step: 'awaiting_consent_form' });
  await safeReply(ctx, [consentPrompt(ctx.env.LIFF_CONSENT_URL)]);
}

// ── 経路 E: 来店時補完の同意書単体提出 LIFF を出す (pkg1_wage) ──────────────────

async function startConsentLiff(ctx: Pkg1Context): Promise<void> {
  await safeReply(ctx, [
    textMessage(
      'ご来店ありがとうございます。\n下記の同意書にお名前・ふりがな・電話番号をご記入ください。',
    ),
    consentPrompt(ctx.env.LIFF_CONSENT_URL),
  ]);
}

/**
 * 経路 D-2: 同意書 submit 後 (consent-callback) に Push で来店予定フローを再開する。
 * 退避した cart (pkg1_cart) があれば店舗選択 carousel を Push し、cart 退避を消す。
 * reply token は使えない (元 webhook でない) ため pushMessage のみ。
 * cart が無い (経路 E の純粋な同意書だけ) なら no-op で false を返す。
 */
export async function resumeReservationAfterConsent(
  env: Env['Bindings'],
  lineClient: LineClient,
  lineUserId: string,
): Promise<boolean> {
  const repo = env as TrycleRepoEnv;
  let cart: QuoteLineItem[] | null = null;
  try {
    cart = await getPkg1Cart(repo, lineUserId);
  } catch (err) {
    console.warn('[trycle-pkg1] getPkg1Cart failed', err);
  }
  if (!cart || cart.length === 0) return false;

  const stores = await listActiveStores(repo).catch(() => [] as Awaited<ReturnType<typeof listActiveStores>>);
  if (stores.length === 0) return false;

  await setReservationSession(repo, lineUserId, { step: 'awaiting_store', cart }).catch((err) => console.error('[trycle-pkg1] setReservationSession failed', err));
  await clearPkg1Cart(repo, lineUserId).catch((err) => console.error('[trycle-pkg1] clearPkg1Cart failed', err));
  await clearPkg1Session(repo, lineUserId).catch((err) => console.error('[trycle-pkg1] clearPkg1Session failed', err));
  try {
    await lineClient.pushMessage(lineUserId, [
      textMessage('ご登録ありがとうございました。\nご来店店舗をお選びください。'),
      reservationStoreCarousel(stores),
    ] as never);
  } catch (err) {
    console.error('[trycle-pkg1] resume reservation push failed', err);
    return false;
  }
  return true;
}

// ── 来店予定フロー (3 段階: 店舗 → 日付 → 時間 → 確認) ─────────────────────────

/** 同意 OK / 既存顧客 で entry。店舗選択 carousel を返す。 */
async function startReservationFlow(ctx: Pkg1Context, cart: QuoteLineItem[]): Promise<void> {
  const env = repoEnv(ctx);
  const stores = await listActiveStores(env).catch((err) => {
    console.error('[trycle-pkg1] listActiveStores failed', err);
    return [] as Awaited<ReturnType<typeof listActiveStores>>;
  });
  if (stores.length === 0) {
    await safeReply(ctx, [textMessage('来店予約の準備でエラーが発生しました。スタッフが折り返します。')]);
    return;
  }
  await setReservationSession(env, ctx.lineUserId, { step: 'awaiting_store', cart });
  await safeReply(ctx, [textMessage('ご来店店舗をお選びください。'), reservationStoreCarousel(stores)]);
}

async function handleReservationPostback(
  action: string,
  value: string | null,
  ctx: Pkg1Context,
): Promise<void> {
  switch (action) {
    case 'pkg1_reserve_store':
      return onStoreSelected(ctx, value);
    case 'pkg1_reserve_date':
      return onDateSelected(ctx, value);
    case 'pkg1_reserve_time':
      return onTimeSelected(ctx, value);
    case 'pkg1_reserve_confirm':
      return onReservationConfirmed(ctx, value);
    default:
      return;
  }
}

// ── ① 店舗選択 → 日付候補 ──────────────────────────────────────────────────────

async function onStoreSelected(ctx: Pkg1Context, storeId: string | null): Promise<void> {
  const env = repoEnv(ctx);
  if (!storeId) return reservationLost(ctx);
  const session = await getReservationSession(env, ctx.lineUserId);
  if (!session) return reservationLost(ctx);
  const store = await findStoreById(env, storeId);
  if (!store) return reservationLost(ctx);

  await setReservationSession(env, ctx.lineUserId, {
    ...session,
    step: 'awaiting_date',
    storeId: store.id,
    storeName: store.name,
    date: undefined,
    visitAtIso: undefined,
  });
  await safeReply(ctx, [reservationDateList(store, generateVisitDays(store, nowJst()))]);
}

// ── ② 日付選択 → 時間候補 ──────────────────────────────────────────────────────

async function onDateSelected(ctx: Pkg1Context, date: string | null): Promise<void> {
  const env = repoEnv(ctx);
  if (!date) return reservationLost(ctx);
  const session = await getReservationSession(env, ctx.lineUserId);
  if (!session?.storeId) return reservationLost(ctx);
  const store = await findStoreById(env, session.storeId);
  if (!store) return reservationLost(ctx);

  const day = findVisitDay(store, date);
  if (!day || day.slots.length === 0) {
    // 候補に無い日 / 枠切れ → 日付選択をやり直してもらう (無反応を防ぐ)。
    await safeReply(ctx, [
      textMessage('恐れ入りますが、別の日をお選びください。'),
      reservationDateList(store, generateVisitDays(store, nowJst())),
    ]);
    return;
  }

  await setReservationSession(env, ctx.lineUserId, {
    ...session,
    step: 'awaiting_time',
    date,
    visitAtIso: undefined,
  });
  await safeReply(ctx, [reservationTimeList(store, day)]);
}

// ── ③ 時間選択 → 確認 ──────────────────────────────────────────────────────────

async function onTimeSelected(ctx: Pkg1Context, datetime: string | null): Promise<void> {
  const env = repoEnv(ctx);
  if (!datetime) return reservationLost(ctx);
  const session = await getReservationSession(env, ctx.lineUserId);
  if (!session?.storeId) return reservationLost(ctx);
  const store = await findStoreById(env, session.storeId);
  if (!store) return reservationLost(ctx);

  // 候補から出た値だが、stale タップ対策で営業時間/grid を再検証する。
  const visitAt = parseJstDatetime(datetime);
  if (!visitAt || !validateVisitAt(store, visitAt).ok) {
    await reofferTimeOrDate(ctx, store, session.date ?? null, '恐れ入りますが、別の時間をお選びください。');
    return;
  }

  await setReservationSession(env, ctx.lineUserId, {
    ...session,
    step: 'awaiting_confirm',
    storeName: store.name,
    visitAtIso: datetime,
  });
  await safeReply(ctx, [reservationConfirmPrompt(store.name, datetime)]);
}

/** session の date から VisitDay を引く。無効/未存在は null。 */
function findVisitDay(
  store: Awaited<ReturnType<typeof findStoreById>>,
  date: string,
): VisitDay | null {
  if (!store) return null;
  return generateVisitDays(store, nowJst()).find((d) => d.date === date) ?? null;
}

/** 時間選択へ戻れるなら戻し、日付が失われていれば日付選択へ倒す (無反応を防ぐ)。 */
async function reofferTimeOrDate(
  ctx: Pkg1Context,
  store: NonNullable<Awaited<ReturnType<typeof findStoreById>>>,
  date: string | null,
  lead: string,
): Promise<void> {
  const day = date ? findVisitDay(store, date) : null;
  if (day && day.slots.length > 0) {
    await safeReply(ctx, [textMessage(lead), reservationTimeList(store, day)]);
    return;
  }
  await safeReply(ctx, [
    textMessage(lead),
    reservationDateList(store, generateVisitDays(store, nowJst())),
  ]);
}

async function onReservationConfirmed(ctx: Pkg1Context, value: string | null): Promise<void> {
  const env = repoEnv(ctx);
  const session = await getReservationSession(env, ctx.lineUserId);
  if (!session) return reservationLost(ctx);

  if (value === 'change') {
    // 時間選択に戻る (date は維持)。store/date が引けなければ日付選択に倒す。
    const store = session.storeId ? await findStoreById(env, session.storeId) : null;
    if (!store) return reservationLost(ctx);
    await setReservationSession(env, ctx.lineUserId, { ...session, step: 'awaiting_time', visitAtIso: undefined });
    await reofferTimeOrDate(ctx, store, session.date ?? null, '別の時間をお選びください。');
    return;
  }
  if (value !== 'ok') return;

  return finalizeReservation(ctx, session);
}

/**
 * 来店予定 session が失効/不整合のときに「タップしても無反応」になるのを防ぐ
 * graceful フォールバック。本物 reservation-flow は silent return だが、実機で
 * 「選択肢が動かない」体験になるため、再開導線を必ず返す (REQ-PKG1 wiring 監査)。
 */
async function reservationLost(ctx: Pkg1Context): Promise<void> {
  await safeReply(ctx, [
    textMessage(
      'ご来店予定の受付が一度リセットされました。\nお手数ですが、もう一度はじめからお選びください。',
    ),
    dispatchPrompt(),
  ]);
}

/** 来店予定確定 → cases + quote_versions 保存 → PDF 発行 → LINE 共有。 */
async function finalizeReservation(ctx: Pkg1Context, session: ReservationState): Promise<void> {
  const env = repoEnv(ctx);
  const quote = buildQuote(session.cart, await getTenantQuoteSettings(env));
  // 表示用 (notifyStaff の文言)・JST 壁時計のまま (formatVisitAt が wall-clock parse する)
  const visitAtIso = session.visitAtIso ?? null;
  // DB 保存用 (cases.visit_scheduled_at は timestamptz)。TZ 無しで投げると UTC 解釈されて
  // dashboard 側 JST 表示で +9h ズレるため "+09:00" 付き ISO に揃える (2026-06-22 事故)
  const visitAtIsoForDb = visitAtIso ? jstWallToIsoZ(visitAtIso) : null;

  // 見積成立 + 来店予約成立。case 生成前に append → 同一 flow_id でバッファに積み、
  // saveQuote 直後の flush で起票/選択行と一緒に case へ移す (グルーピング維持)。
  await appendChatSummary(env, ctx.lineUserId, {
    flowType: 'pkg1',
    speaker: 'bot',
    text: `概算見積 ¥${quote.total.toLocaleString('ja-JP')}`,
  });
  await appendChatSummary(env, ctx.lineUserId, {
    flowType: 'pkg1',
    speaker: '顧客',
    text: visitAtIso
      ? `来店予定: ${session.storeName ?? '店舗'} ${formatVisitAt(visitAtIso)}`
      : `来店予定: ${session.storeName ?? '店舗'}`,
  });

  const customerId = await findCustomerIdByLineUserId(env, ctx.lineUserId).catch(() => null);
  // saveQuoteSafely 内で flushChatSummaryBuffer がバッファを case へ移す。
  const saved = await saveQuoteSafely(ctx, {
    quote,
    customerId,
    storeId: session.storeId ?? null,
    visitScheduledAt: visitAtIsoForDb,
    caseLabel: '来店予定',
    statusKey: 'booked',
  });

  const customer = await resolveCustomerContact(ctx);
  const customerName = customer.name; // notifyStaff (下) でも使う
  const pdf = await issueEstimatePdf(ctx.env, {
    quote,
    customerName,
    customerPhone: customer.phone,
    storeName: session.storeName ?? null,
    quoteNo: saved?.quoteNo ?? null,
    lineUserId: ctx.lineUserId,
  });
  const pdfUrl = resolvePdfUrl(pdf, '来店予定', ctx.lineUserId);
  if (saved && pdfUrl) await updateQuotePdfUrl(env, saved, pdfUrl).catch((err) => console.error('[trycle-pkg1] updateQuotePdfUrl failed', err));

  // 店舗スタッフへ Gmail 通知 (REQ-PKG1-015・見積サマリ + PDF 同梱)。
  await notifyStaff(ctx.env, {
    lineUserId: ctx.lineUserId,
    customerName,
    reason: '来店予定の受付',
    estimateSummary: estimateSummaryText(session.cart),
    pdfUrl,
    note: visitAtIso ? `来店予定: ${formatVisitAt(visitAtIso)}` : null,
  }).catch((err) => console.error('[trycle-pkg1] notifyStaff (reservation) failed', err));

  await appendChatSummary(env, ctx.lineUserId, {
    flowType: 'pkg1',
    speaker: 'bot',
    text: 'スタッフ引継: 来店予定の受付',
  });

  await clearReservationSession(env, ctx.lineUserId).catch((err) => console.error('[trycle-pkg1] clearReservationSession failed', err));
  await clearPkg1Session(env, ctx.lineUserId).catch((err) => console.error('[trycle-pkg1] clearPkg1Session failed', err));

  const visitLabel = visitAtIso ? formatVisitAt(visitAtIso) : '';
  await safeReply(ctx, [
    textMessage(
      `スタッフに連絡しました。${session.storeName ?? '店舗'}にて${visitLabel}にお待ちしております。`,
    ),
    textMessage(formatQuoteWithPdf(quote, pdfUrl)),
  ]);
}

// ── スタッフ送り (escalate) ───────────────────────────────────────────────────

/**
 * 確定不能症状 (region その他・symptom/variant sample=null・labor 解決不能) の
 * スタッフ送り。専用文言 + notifyStaff (見積サマリ同梱) + 有人モード。
 *
 * inquiryText = お客様の選択ラベル (region/symptom)。classifyInquiry (Add-D) が
 * これを起点に種別タグを判定する (省略すると定型 reason が誤分類されるため・
 * REQ-ADD-D-001 メニュー起点判定 / REQ-ADD-F-002 カーボン補修=矢野口固定)。
 */
async function finishWithEscalation(ctx: Pkg1Context, inquiryText?: string): Promise<void> {
  await escalate(
    ctx,
    '確定不能症状',
    '確定のお見積もりが難しいご相談のため、スタッフから折り返しご連絡いたします 🙇',
    inquiryText,
  );
}

/**
 * スタッフ送り共通: session 破棄 + 有人モード + Gmail 通知 (tag/店舗振り分け・
 * 見積サマリ同梱) + 文言 reply。
 *
 * inquiryText を渡すと classifyInquiry (Add-D) がそれを起点に種別タグを判定する。
 * 省略時は定型 reason を分類してしまい、カーボン補修等の選択が「other」へ誤分類
 * される (REQ-ADD-D-001 受入基準・REQ-ADD-F-002 違反) ため、呼び出し側は可能な
 * 限り選択ラベルを渡すこと。
 */
async function escalate(
  ctx: Pkg1Context,
  reason: string,
  introText: string,
  inquiryText?: string,
): Promise<void> {
  const env = repoEnv(ctx);
  // 見積中なら同梱物 (cart サマリ) を集める (REQ-PKG1-017)。
  const session = await getPkg1Session(env, ctx.lineUserId).catch(() => null);
  const estimateSummary =
    session && session.cart.length > 0 ? estimateSummaryText(session.cart) : null;
  const customerName = await resolveCustomerName(ctx);

  await clearPkg1Session(env, ctx.lineUserId).catch((err) => console.error('[trycle-pkg1] clearPkg1Session failed', err));
  await setManualMode(env, ctx.lineUserId).catch((err) => console.error('[trycle-pkg1] setManualMode failed', err));

  await notifyStaff(ctx.env, {
    lineUserId: ctx.lineUserId,
    customerName,
    reason,
    estimateSummary,
    pdfUrl: null,
    note: null,
    // 種別タグ (Add-D) は選択ラベル起点で判定。無ければ reason へフォールバック
    // (空文字も含めて分類根拠が無いとみなす)。
    inquiryText: inquiryText && inquiryText.trim() !== '' ? inquiryText : reason,
  }).catch((err) => console.error('[trycle-pkg1] notifyStaff failed', err));

  // スタッフ送り。直近 case があれば append・無ければバッファ (後続 case 生成時に flush)。
  await appendChatSummary(env, ctx.lineUserId, {
    flowType: 'pkg1',
    speaker: 'bot',
    text: `スタッフ引継: ${inquiryText && inquiryText.trim() !== '' ? inquiryText : reason}`,
  });

  await safeReply(ctx, [
    textMessage(introText),
    textMessage(
      'この後はスタッフが直接ご対応します。ご相談内容をこのトークにお送りください。\nbot に戻るときは下のメニューから操作してください。',
    ),
  ]);
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function currentSession(ctx: Pkg1Context): Promise<Pkg1State> {
  const session = await getPkg1Session(repoEnv(ctx), ctx.lineUserId).catch((err) => {
    // A read failure here silently resets the flow to an empty session, which
    // looks like "the bot stopped responding mid-flow". Surface it explicitly.
    console.error('[trycle-pkg1] currentSession getPkg1Session failed', err);
    return null;
  });
  if (!session) {
    console.log('[trycle-pkg1] currentSession empty (no active session)', ctx.lineUserId);
    return emptyPkg1State();
  }
  return session;
}

function currentSymptom(pending: PendingSelection): Symptom | undefined {
  return findRegionByValue(pending.regionValue)?.symptoms?.[pending.symptomIndex];
}

/**
 * pending 選択の部位+作業ラベルを連結 (種別タグ判定 Add-D の起点)。
 * region/symptom が解決できなければ空文字 (escalate 側で reason へフォールバック)。
 */
function pendingLabel(pending: PendingSelection | undefined): string {
  if (!pending) return '';
  const region = findRegionByValue(pending.regionValue);
  const symptom = region?.symptoms?.[pending.symptomIndex];
  return [region?.label, symptom?.label].filter(Boolean).join(' ');
}

function parseDispatch(value: string | null): Dispatch | null {
  if (value === 'identified' || value === 'comprehensive' || value === 'unknown') return value;
  return null;
}

/**
 * customers テーブルから name + phone を引く。pdf_only / reserve とも同じ仕様:
 * - 引ければ name / phone 両方使う (PDF の「お客様」「TEL」欄に反映)
 * - 引けなければ呼び出し側で `'お客様'` / `'—'` にフォールバック (trycle-pkg1-pdf.ts)
 */
async function resolveCustomerContact(
  ctx: Pkg1Context,
): Promise<{ name: string | null; phone: string | null }> {
  try {
    const customer = await findCustomerByLineUserId(repoEnv(ctx), ctx.lineUserId);
    return { name: customer?.name ?? null, phone: customer?.phone ?? null };
  } catch {
    return { name: null, phone: null };
  }
}

async function resolveCustomerName(ctx: Pkg1Context): Promise<string | null> {
  return (await resolveCustomerContact(ctx)).name;
}

interface SaveQuoteArgs {
  readonly quote: Quote;
  readonly customerId: string | null;
  readonly storeId?: string | null;
  readonly visitScheduledAt: string | null;
  readonly caseLabel: string;
  /**
   * cases.status_id 振り分けの key (経路別)。dashboard 側 case_statuses.key と一致
   * させると正しく振り分け、不一致なら findInitialCaseStatus に fallback する。
   * 既定 (未指定) は fallback と同じく初期 status。
   */
  readonly statusKey?: string;
}

/**
 * cases + quotes + quote_versions に保存する (v1.2.1 §7 #3)。店舗が未指定なら
 * 先頭の有効店舗を採番店舗に使う (pdf_only ルートは店舗未選択のため)。失敗しても
 * フローは止めない (見積保存はトレース用・ユーザー体験を優先・null を返す)。
 */
async function saveQuoteSafely(ctx: Pkg1Context, args: SaveQuoteArgs): Promise<SavedQuote | null> {
  const env = repoEnv(ctx);
  try {
    const statusByKey = args.statusKey
      ? await findCaseStatusByKey(env, args.statusKey).catch(() => null)
      : null;
    const status = statusByKey ?? await findInitialCaseStatus(env);
    if (!status) {
      console.error('[trycle-pkg1] saveQuote skipped: no case_statuses');
      return null;
    }
    let storeId = args.storeId ?? null;
    let storeCode: string;
    if (storeId) {
      storeCode = await findStoreCode(env, storeId);
    } else {
      const def = await findDefaultStore(env);
      if (!def) {
        console.error('[trycle-pkg1] saveQuote skipped: no active store');
        return null;
      }
      storeId = def.id;
      storeCode = def.code;
    }
    const saved = await saveQuote(env, {
      lineUserId: ctx.lineUserId,
      customerId: args.customerId,
      storeId,
      storeCode,
      statusId: status.id,
      quote: args.quote,
      caseLabel: args.caseLabel,
      visitScheduledAt: args.visitScheduledAt,
      // chat_summary はフロー単位イベント行で構成する (v1.4)。case 生成直後に
      // バッファ (起票〜メニュー選択) を flush し、空なら既定文言を入れておく。
      chatSummary: `整備見積 (概算 ${args.quote.total}円・LINE bot)`,
    });
    // 案件起票より前のイベント (起票/メニュー選択) を新 case 行へ移す。
    await flushChatSummaryBuffer(env, ctx.lineUserId, saved.caseId);
    return saved;
  } catch (err) {
    console.error('[trycle-pkg1] saveQuote failed', err);
    return null;
  }
}

/** スタッフ通知用の見積サマリ (cart 明細 + 税抜小計)。 */
function estimateSummaryText(cart: ReadonlyArray<QuoteLineItem>): string {
  const lines = cart.map((item) => {
    const qty = item.qty > 1 ? ` ×${item.qty}` : '';
    return `・${item.name}${qty}`;
  });
  lines.push(`小計(税抜): ${cartSubtotal(cart)}円`);
  return lines.join('\n');
}

/**
 * PDF 発行結果から URL を取り出す。失敗 (ok=false) または URL 欠落の場合は
 * 必ず root cause を console.error に出す (silent fail 防止・前回 commit の方針継続)。
 * GAS 側のテンプレ未刷新 / 404 / 500 / 応答不正はここに error 文字列として現れる。
 */
function resolvePdfUrl(
  pdf: EstimatePdfResult,
  flow: string,
  lineUserId: string,
): string | null {
  if (pdf.ok && pdf.pdfUrl) return pdf.pdfUrl;
  console.error(
    `[trycle-pkg1] estimate PDF unavailable (flow=${flow} user=${lineUserId} ok=${pdf.ok}):`,
    pdf.error ?? (pdf.ok ? 'GAS responded ok but pdfUrl missing' : 'unknown error'),
  );
  return null;
}

/** 見積 text に PDF URL (発行できていれば) を添える。失敗時は明示エラー文言。 */
function formatQuoteWithPdf(quote: Quote, pdfUrl: string | null): string {
  const head = formatQuoteText(quote);
  if (pdfUrl) {
    return `${head}\n\nお見積書（PDF）を発行しました。\n${pdfUrl}`;
  }
  return `${head}\n\nお見積書（PDF）の生成に失敗しました。お見積もり内容はスタッフへ共有しましたので、スタッフが確認のうえご連絡いたします。`;
}

async function safeReply(ctx: Pkg1Context, messages: LineMessage[]): Promise<void> {
  try {
    await ctx.lineClient.replyMessage(ctx.replyToken, messages.slice(0, MAX_REPLY_MESSAGES) as never);
  } catch (err) {
    console.error('[trycle-pkg1] reply failed', err);
  }
}
