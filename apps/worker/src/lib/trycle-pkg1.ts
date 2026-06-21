/**
 * TRYCLE Pkg1「整備見積もり」postback dispatcher (経路 A〜D)。
 *
 *   経路 A  入口 3 択 + ふりわけ + スタッフ相談 (有人切替)
 *   経路 B  カテゴリ → メニュー → variant → カート積み上げ
 *   経路 C  カート確定 → 見積 Bubble (概算) → 来店予定/相談 2 択
 *   経路 D  同意書ゲート → 来店予定ヒアリング → cases 作成 → PDF/Gmail
 *
 * 状態は Supabase bot_sessions (kind=pkg1_estimate)。会話履歴は LH messages_log (D1)。
 * 設計: Pkg1 詳細設計 v1.1.1 (page 386050ad6a7e81f8b701cd52c9201af6)。
 */
import type { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../index.js';
import { buildQuote, makeLineItem, PARTS_NOTICE, type QuoteLineItem } from './quote.js';
import {
  findCustomerByLineUserId,
  findCustomerIdByLineUserId,
  hasValidMaintenanceConsent,
  listActiveStores,
  type TrycleRepoEnv,
} from './trycle-repo.js';
import {
  listLaborCategories,
  listLaborByCategory,
  findLaborById,
  listLaborOptions,
  findInitialCaseStatus,
  insertCase,
  updateCaseVisit,
  type Pkg1LaborEntry,
} from './trycle-pkg1-repo.js';
import {
  getPkg1Session,
  upsertPkg1Session,
  clearPkg1Session,
  emptyPkg1State,
  cartSubtotal,
  setManualMode,
  type Pkg1State,
  type CartItem,
} from './trycle-session.js';
import {
  generateVisitDays,
  nowJst,
  type VisitDay,
} from './trycle-visit-slots.js';
import { parseJstDatetime, validateVisitAt } from './trycle-store-hours.js';
import { notifyStaff } from './trycle-staff.js';
import { issueEstimatePdf } from './trycle-pkg1-pdf.js';
import {
  buildEntryBubble,
  buildCategoryBubble,
  buildLaborListBubble,
  buildVariantBubble,
  buildCartBubble,
  buildEstimateBubble,
  buildConsentPromptBubble,
  buildVisitDayBubble,
  buildVisitTimeBubble,
  buildAckBubble,
  DISPATCH_LABELS,
  type Pkg1Dispatch,
  type FlexMessage,
} from './trycle-pkg1-flex.js';

const PKG1_PREFIX = 'pkg1_';

export function isPkg1Postback(data: string): boolean {
  return data.startsWith(PKG1_PREFIX);
}

export interface Pkg1Context {
  readonly replyToken: string;
  readonly lineUserId: string;
  readonly lineClient: LineClient;
  readonly env: Env['Bindings'];
}

/**
 * Pkg1 postback を捌く。handled=true なら caller は auto-reply に流さない。
 */
export async function handlePkg1Postback(data: string, ctx: Pkg1Context): Promise<boolean> {
  if (!isPkg1Postback(data)) return false;
  try {
    await route(data, ctx);
  } catch (err) {
    console.error('[trycle-pkg1] handle failed', data, err);
    await safeReply(ctx, [
      { type: 'text', text: '見積もりの処理に失敗しました。少し時間をおいて再度お試しください。' },
    ]);
  }
  return true;
}

async function route(data: string, ctx: Pkg1Context): Promise<void> {
  // 入口・状況ふりわけ 3 択 (経路 A・本物 pkg1-estimate.ts onDispatch に忠実)。
  //   identified    → 正規見積ルート (カテゴリ選択へ)
  //   comprehensive → 現物確認が必要 → スタッフ相談誘導 (経路 B には進めない)
  //   unknown       → 同上スタッフ相談誘導
  if (data === 'pkg1_start') return replyEntry(ctx);
  if (data === 'pkg1_dispatch_identified') return onDispatch(ctx, 'identified');
  if (data === 'pkg1_dispatch_comprehensive') return onDispatch(ctx, 'comprehensive');
  if (data === 'pkg1_dispatch_unknown') return onDispatch(ctx, 'unknown');
  // route B 内のカテゴリ再表示 (「他の整備を追加」「カテゴリへ戻る」)。
  if (data === 'pkg1_categories') return replyCategories(ctx);
  if (data === 'pkg1_staff_consult') return startManualMode(ctx, '相談 (入口)');
  if (data === 'pkg1_staff_estimate') return startManualMode(ctx, '見積後相談');

  // 経路 B: カテゴリ → メニュー → variant → カート
  if (data.startsWith('pkg1_cat_')) return replyLaborList(ctx, data.slice('pkg1_cat_'.length));
  if (data.startsWith('pkg1_labor_')) return replyVariant(ctx, data.slice('pkg1_labor_'.length));
  if (data.startsWith('pkg1_opt_')) return addOptionAndCart(ctx, data.slice('pkg1_opt_'.length));
  if (data.startsWith('pkg1_add_')) return addToCart(ctx, data.slice('pkg1_add_'.length), []);

  // 経路 C: 見積確認
  if (data === 'pkg1_confirm') return replyEstimate(ctx);

  // 経路 C: PDF だけ受け取る (本物 pkg1-estimate.ts finishPdfOnly に忠実)。
  // 連絡先・同意書・cases を取らずに PDF を発行して LINE に送り、終了する。
  if (data === 'pkg1_pdf_only') return replyPdfOnly(ctx);

  // 経路 D: 来店予定 → 同意書 → cases → PDF
  if (data === 'pkg1_visit_start') return replyVisitDays(ctx);
  if (data.startsWith('pkg1_visit_day_')) return replyVisitTimes(ctx, data.slice('pkg1_visit_day_'.length));
  if (data.startsWith('pkg1_visit_at_')) return confirmVisit(ctx, data.slice('pkg1_visit_at_'.length));

  // 未知の pkg1_ postback はリセット案内。
  await safeReply(ctx, [
    buildAckBubble('整備見積もり', '最初からやり直す場合は下のボタンを押してください。', [
      { label: '整備見積もりを始める', data: 'pkg1_start', style: 'primary' },
    ]),
  ]);
}

// ── 経路 A ────────────────────────────────────────────────────────────────────

async function replyEntry(ctx: Pkg1Context): Promise<void> {
  // 入口タップで session をリセット (設計 §7 ライフサイクル)。
  await clearPkg1Session(ctx.env as TrycleRepoEnv, ctx.lineUserId).catch(() => {});
  await safeReply(ctx, [buildEntryBubble()]);
}

/**
 * 状況ふりわけ 3 択を捌く (本物 pkg1-estimate.ts onDispatch に忠実)。
 *   - identified    → カテゴリ選択 (正規見積ルート)。
 *   - comprehensive → 現物確認が必要なため、`「<ラベル>」ですね。…` の文言で
 *                     スタッフ相談誘導をもって完成 (経路 B には進めない)。
 *   - unknown       → 同上スタッフ相談誘導。
 */
async function onDispatch(ctx: Pkg1Context, dispatch: Pkg1Dispatch): Promise<void> {
  if (dispatch === 'identified') {
    return replyCategories(ctx);
  }
  // 包括メンテ / 原因がわからない → 見積セッションを破棄し、本物文言で
  // スタッフ相談誘導をもって完成 (経路 B には進めない)。
  await clearPkg1Session(ctx.env as TrycleRepoEnv, ctx.lineUserId).catch(() => {});
  return startManualMode(ctx, DISPATCH_LABELS[dispatch], {
    introText: `「${DISPATCH_LABELS[dispatch]}」ですね。こちらは現物確認が必要なため、スタッフがご相談を承ります。`,
  });
}

interface StartManualModeOptions {
  /** ack Bubble の前に出す導入文 (状況ふりわけのスタッフ送りで本物文言を出すため)。 */
  readonly introText?: string;
}

async function startManualMode(
  ctx: Pkg1Context,
  reason: string,
  options: StartManualModeOptions = {},
): Promise<void> {
  await setManualMode(ctx.env as TrycleRepoEnv, ctx.lineUserId);

  // 見積中なら同梱物 (cart サマリ) を付ける (REQ-PKG1-017)。
  const session = await getPkg1Session(ctx.env as TrycleRepoEnv, ctx.lineUserId).catch(() => null);
  const customerName = await resolveCustomerName(ctx);
  const estimateSummary = session && session.cart.length > 0 ? cartSummaryText(session.cart) : null;

  await notifyStaff(ctx.env, {
    lineUserId: ctx.lineUserId,
    customerName,
    reason,
    estimateSummary,
    pdfUrl: null,
    note: null,
  }).catch((err) => {
    console.error('[trycle-pkg1] notifyStaff failed', err);
  });

  const messages: Array<FlexMessage | { type: 'text'; text: string }> = [];
  if (options.introText) {
    messages.push({ type: 'text', text: options.introText });
  }
  messages.push(
    buildAckBubble(
      'スタッフにおつなぎします',
      'この後はスタッフが直接ご対応します。ご相談内容をこのトークにお送りください。\n\nbot に戻るときは下のメニューから操作してください。',
      [],
    ),
  );
  await safeReply(ctx, messages);
}

// ── 経路 B ────────────────────────────────────────────────────────────────────

async function replyCategories(ctx: Pkg1Context): Promise<void> {
  const categories = await listLaborCategories(ctx.env as TrycleRepoEnv);
  if (categories.length === 0) {
    await safeReply(ctx, [
      buildAckBubble('整備メニュー準備中', 'ただいまメニューをご用意できません。スタッフにご相談ください。', [
        { label: 'スタッフに相談', data: 'pkg1_staff_consult', style: 'primary' },
      ]),
    ]);
    return;
  }
  await ensureSession(ctx, (s) => ({ ...s, step: 'category_select' }));
  await safeReply(ctx, [buildCategoryBubble(categories)]);
}

async function replyLaborList(ctx: Pkg1Context, category: string): Promise<void> {
  const labors = await listLaborByCategory(ctx.env as TrycleRepoEnv, category);
  if (labors.length === 0) {
    await safeReply(ctx, [
      buildAckBubble('該当メニューなし', `「${category}」のメニューが見つかりませんでした。`, [
        { label: 'カテゴリへ戻る', data: 'pkg1_categories', style: 'secondary' },
      ]),
    ]);
    return;
  }
  await ensureSession(ctx, (s) => ({ ...s, step: 'labor_select', selected_category: category }));
  await safeReply(ctx, [buildLaborListBubble(category, labors)]);
}

async function replyVariant(ctx: Pkg1Context, laborId: string): Promise<void> {
  const labor = await findLaborById(ctx.env as TrycleRepoEnv, laborId);
  if (!labor) {
    await safeReply(ctx, [
      buildAckBubble('メニューが見つかりません', '選択した整備メニューが見つかりませんでした。', [
        { label: 'カテゴリへ戻る', data: 'pkg1_categories', style: 'secondary' },
      ]),
    ]);
    return;
  }
  // open-ended (確定額を出せない) はカートに積まずスタッフ送り (分岐図 v3・REQ-018)。
  if (labor.price_open_ended) {
    await startManualMode(ctx, `見積不可症状: ${labor.name}`);
    return;
  }
  const options = await listLaborOptions(ctx.env as TrycleRepoEnv, laborId);
  if (options.length === 0) {
    // オプションが無ければそのままカートへ。
    await addToCart(ctx, laborId, []);
    return;
  }
  await ensureSession(ctx, (s) => ({ ...s, selected_labor_id: laborId }));
  await safeReply(ctx, [buildVariantBubble(labor, options)]);
}

/** pkg1_opt_<laborId>_<optionId> → そのオプション 1 つを付けてカート追加。 */
async function addOptionAndCart(ctx: Pkg1Context, rest: string): Promise<void> {
  const sep = rest.indexOf('_');
  if (sep < 0) {
    await addToCart(ctx, rest, []);
    return;
  }
  const laborId = rest.slice(0, sep);
  const optionId = rest.slice(sep + 1);
  await addToCart(ctx, laborId, [optionId]);
}

async function addToCart(ctx: Pkg1Context, laborId: string, optionIds: string[]): Promise<void> {
  const labor = await findLaborById(ctx.env as TrycleRepoEnv, laborId);
  if (!labor) {
    await safeReply(ctx, [
      buildAckBubble('追加に失敗しました', '選択したメニューが見つかりませんでした。', [
        { label: 'カテゴリへ戻る', data: 'pkg1_categories', style: 'secondary' },
      ]),
    ]);
    return;
  }
  const allOptions = await listLaborOptions(ctx.env as TrycleRepoEnv, laborId);
  const selected = allOptions.filter((o) => optionIds.includes(o.id));
  const item = buildCartItem(labor, selected);

  const session = (await getPkg1Session(ctx.env as TrycleRepoEnv, ctx.lineUserId)) ?? emptyPkg1State();
  const nextCart = [...session.cart, item];
  await upsertPkg1Session(ctx.env as TrycleRepoEnv, ctx.lineUserId, {
    ...session,
    step: 'cart_review',
    cart: nextCart,
  });
  await safeReply(ctx, [buildCartBubble(nextCart)]);
}

export function buildCartItem(
  labor: Pkg1LaborEntry,
  options: ReadonlyArray<{ id: string; name: string; price: number }>,
): CartItem {
  const optionTotal = options.reduce((s, o) => s + o.price, 0);
  return {
    labor_id: labor.id,
    code: labor.code,
    name: labor.name,
    unit_price: labor.price,
    unit_price_max: labor.price_max ?? null,
    qty: 1,
    option_ids: options.map((o) => o.id),
    option_names: options.map((o) => o.name),
    option_total: optionTotal,
  };
}

// ── 経路 C ────────────────────────────────────────────────────────────────────

async function replyEstimate(ctx: Pkg1Context): Promise<void> {
  const session = await getPkg1Session(ctx.env as TrycleRepoEnv, ctx.lineUserId);
  if (!session || session.cart.length === 0) {
    await safeReply(ctx, [
      buildAckBubble('カートが空です', '見積もりたい整備メニューを先にお選びください。', [
        { label: '整備メニューを選ぶ', data: 'pkg1_categories', style: 'primary' },
      ]),
    ]);
    return;
  }
  const quote = buildQuoteFromCart(session.cart);
  await upsertPkg1Session(ctx.env as TrycleRepoEnv, ctx.lineUserId, { ...session, step: 'quoted' });
  await safeReply(ctx, [buildEstimateBubble(quote, PARTS_NOTICE)]);
}

/**
 * PDF だけ受け取る (本物 pkg1-estimate.ts finishPdfOnly に忠実)。
 *
 * 連絡先入力・同意書・cases 作成をスキップし、見積 PDF を発行して Drive 保存 +
 * 店舗へ Gmail 通知 (graceful degrade) のうえ、LINE に PDF URL を送って終了する。
 * 来店予定 (経路 D) とは違い案件 (cases) は作らない。
 */
async function replyPdfOnly(ctx: Pkg1Context): Promise<void> {
  const session = await getPkg1Session(ctx.env as TrycleRepoEnv, ctx.lineUserId);
  if (!session || session.cart.length === 0) {
    await safeReply(ctx, [
      buildAckBubble('カートが空です', '見積もりたい整備メニューを先にお選びください。', [
        { label: '整備メニューを選ぶ', data: 'pkg1_categories', style: 'primary' },
      ]),
    ]);
    return;
  }

  const quote = buildQuoteFromCart(session.cart);
  const customerName = await resolveCustomerName(ctx);

  // PDF 発行 + Drive 保存 (失敗してもフローを止めない)。
  const pdf = await issueEstimatePdf(ctx.env, {
    quote,
    customerName,
    storeName: null,
    quoteNo: null,
    partsNotice: PARTS_NOTICE,
    disclaimer: quote.disclaimer,
  });
  const pdfUrl = pdf.ok ? (pdf.pdfUrl ?? null) : null;

  // 店舗へ Gmail 通知 (PDF 発行のみ・cases なし)。未設定なら no-op。
  await notifyStaff(ctx.env, {
    lineUserId: ctx.lineUserId,
    customerName,
    reason: 'PDF 発行のみ',
    estimateSummary: cartSummaryText(session.cart),
    pdfUrl,
    note: '来店予定・同意書なしで PDF のみ発行',
  }).catch((err) => console.error('[trycle-pkg1] notifyStaff (pdf_only) failed', err));

  // session を完了させる (cases は作らない・履歴は messages_log)。
  await clearPkg1Session(ctx.env as TrycleRepoEnv, ctx.lineUserId).catch(() => {});

  const doneButtons = pdfUrl
    ? [{ label: '見積書 PDF を開く', uri: pdfUrl, style: 'primary' as const }]
    : [];
  await safeReply(ctx, [
    buildAckBubble(
      'お見積書 (PDF) を発行しました',
      [
        pdfUrl
          ? '下のボタンから PDF をご確認いただけます。'
          : '見積書はスタッフよりご案内します。',
        '※ 概算のお見積もりです。正式なお見積もりは現車確認後にご案内します。',
        'またのお問い合わせをお待ちしております。',
      ].join('\n'),
      doneButtons,
    ),
  ]);
}

export function buildQuoteFromCart(cart: ReadonlyArray<CartItem>) {
  const lineItems: QuoteLineItem[] = cart.map((item) => {
    const unit = item.unit_price + item.option_total;
    const unitMax =
      item.unit_price_max != null ? item.unit_price_max + item.option_total : null;
    const name =
      item.option_names.length > 0 ? `${item.name} (${item.option_names.join('/')})` : item.name;
    return makeLineItem({ name, unitPrice: unit, unitPriceMax: unitMax, qty: item.qty });
  });
  return buildQuote(lineItems);
}

// ── 経路 D ────────────────────────────────────────────────────────────────────

async function replyVisitDays(ctx: Pkg1Context): Promise<void> {
  const session = await getPkg1Session(ctx.env as TrycleRepoEnv, ctx.lineUserId);
  if (!session || session.cart.length === 0) {
    await safeReply(ctx, [
      buildAckBubble('見積もりが必要です', '先に整備メニューを選んで見積もりを確認してください。', [
        { label: '整備メニューを選ぶ', data: 'pkg1_categories', style: 'primary' },
      ]),
    ]);
    return;
  }
  const stores = await listActiveStores(ctx.env as TrycleRepoEnv);
  const store = stores[0];
  if (!store) {
    await safeReply(ctx, [
      buildAckBubble('店舗情報が取得できません', 'スタッフにご相談ください。', [
        { label: 'スタッフに相談', data: 'pkg1_staff_estimate', style: 'primary' },
      ]),
    ]);
    return;
  }
  const days = generateVisitDays(store, nowJst());
  if (days.length === 0) {
    await safeReply(ctx, [
      buildAckBubble('来店枠が見つかりません', '直近の営業日に空きがありません。スタッフにご相談ください。', [
        { label: 'スタッフに相談', data: 'pkg1_staff_estimate', style: 'primary' },
      ]),
    ]);
    return;
  }
  await upsertPkg1Session(ctx.env as TrycleRepoEnv, ctx.lineUserId, {
    ...session,
    step: 'visit_time_select',
    store_id: store.id,
  });
  await safeReply(ctx, [buildVisitDayBubble(days)]);
}

async function replyVisitTimes(ctx: Pkg1Context, date: string): Promise<void> {
  const session = await getPkg1Session(ctx.env as TrycleRepoEnv, ctx.lineUserId);
  if (!session?.store_id) {
    await replyVisitDays(ctx);
    return;
  }
  const stores = await listActiveStores(ctx.env as TrycleRepoEnv);
  const store = stores.find((s) => s.id === session.store_id) ?? stores[0];
  if (!store) {
    await replyVisitDays(ctx);
    return;
  }
  const days = generateVisitDays(store, nowJst());
  const day: VisitDay | undefined = days.find((d) => d.date === date);
  if (!day) {
    await safeReply(ctx, [
      buildAckBubble('この日の枠が埋まりました', '別の日をお選びください。', [
        { label: '来店日を選び直す', data: 'pkg1_visit_start', style: 'secondary' },
      ]),
    ]);
    return;
  }
  await safeReply(ctx, [buildVisitTimeBubble(day)]);
}

/**
 * 来店時刻確定 → 同意書ゲート → cases 作成 → PDF/Gmail (経路 D 完了)。
 */
async function confirmVisit(ctx: Pkg1Context, visitValue: string): Promise<void> {
  const session = await getPkg1Session(ctx.env as TrycleRepoEnv, ctx.lineUserId);
  if (!session || session.cart.length === 0 || !session.store_id) {
    await replyVisitDays(ctx);
    return;
  }
  // 時刻を再検証 (postback 改竄・営業時間外を弾く)。
  const visitAt = parseJstDatetime(visitValue);
  if (!visitAt) {
    await safeReply(ctx, [
      buildAckBubble('時刻の形式が不正です', '来店時刻をお選び直しください。', [
        { label: '来店日を選び直す', data: 'pkg1_visit_start', style: 'secondary' },
      ]),
    ]);
    return;
  }
  const stores = await listActiveStores(ctx.env as TrycleRepoEnv);
  const store = stores.find((s) => s.id === session.store_id);
  if (store) {
    const verdict = validateVisitAt(store, visitAt);
    if (!verdict.ok) {
      await safeReply(ctx, [
        buildAckBubble('その時刻は選べません', `${verdict.reason}\n別の時刻をお選びください。`, [
          { label: '来店日を選び直す', data: 'pkg1_visit_start', style: 'secondary' },
        ]),
      ]);
      return;
    }
  }

  // 同意書ゲート (REQ-PKG1-016)。未同意なら LIFF 同意書へ誘導して中断。
  const consentOk = await hasValidMaintenanceConsent(ctx.env as TrycleRepoEnv, ctx.lineUserId);
  if (!consentOk) {
    const liffUrl = ctx.env.LIFF_CONSENT_URL;
    if (liffUrl) {
      await safeReply(ctx, [buildConsentPromptBubble(liffUrl)]);
    } else {
      await safeReply(ctx, [
        buildAckBubble('同意書のご確認をお願いします', 'スタッフより同意書をご案内します。', [
          { label: 'スタッフに相談', data: 'pkg1_staff_estimate', style: 'primary' },
        ]),
      ]);
    }
    // session を保持したまま中断 (同意後にユーザーが再度来店予定を選べる)。
    return;
  }

  await finalizeCase(ctx, session, visitAt.toISOString());
}

/** cases 作成 + PDF 発行 + LINE 共有 + Gmail 通知 (経路 D 終端)。 */
async function finalizeCase(
  ctx: Pkg1Context,
  session: Pkg1State,
  visitScheduledAtIso: string,
): Promise<void> {
  const env = ctx.env as TrycleRepoEnv;
  const quote = buildQuoteFromCart(session.cart);

  const [customerId, customerName, status] = await Promise.all([
    findCustomerIdByLineUserId(env, ctx.lineUserId).catch(() => null),
    resolveCustomerName(ctx),
    findInitialCaseStatus(env).catch(() => null),
  ]);

  if (!status) {
    await safeReply(ctx, [
      buildAckBubble('受付に失敗しました', 'ステータス設定が未完了です。スタッフにご相談ください。', [
        { label: 'スタッフに相談', data: 'pkg1_staff_estimate', style: 'primary' },
      ]),
    ]);
    return;
  }

  // PDF 発行 (失敗しても受付は続行する)。
  const pdf = await issueEstimatePdf(ctx.env, {
    quote,
    customerName,
    storeName: null,
    quoteNo: null,
    partsNotice: PARTS_NOTICE,
    disclaimer: quote.disclaimer,
  });
  const pdfUrl = pdf.ok ? (pdf.pdfUrl ?? null) : null;

  // cases 作成。
  let caseId: string | null = null;
  try {
    const created = await insertCase(env, {
      lineUserId: ctx.lineUserId,
      customerId,
      storeId: session.store_id ?? null,
      statusId: status.id,
      total: quote.total,
      quoteNo: null,
      pdfUrl,
      visitScheduledAt: visitScheduledAtIso,
      workNote: cartSummaryText(session.cart),
      chatSummary: `整備見積 (概算 ${quote.total}円・LINE bot)`,
    });
    caseId = created.id;
    await updateCaseVisit(env, caseId, visitScheduledAtIso).catch(() => {});
  } catch (err) {
    console.error('[trycle-pkg1] insertCase failed', err);
    await safeReply(ctx, [
      buildAckBubble('受付に失敗しました', '案件の登録に失敗しました。スタッフにご相談ください。', [
        { label: 'スタッフに相談', data: 'pkg1_staff_estimate', style: 'primary' },
      ]),
    ]);
    return;
  }

  // Gmail 通知 (REQ-PKG1-015・店舗スタッフへ見積保存完了 + 同梱物)。
  await notifyStaff(ctx.env, {
    lineUserId: ctx.lineUserId,
    customerName,
    reason: '来店予定の受付',
    estimateSummary: cartSummaryText(session.cart),
    pdfUrl,
    note: `来店予定: ${visitScheduledAtIso}`,
  }).catch((err) => console.error('[trycle-pkg1] notifyStaff (case) failed', err));

  // session を完了させる (作業メモは残さない・履歴は messages_log)。
  await clearPkg1Session(env, ctx.lineUserId).catch(() => {});

  // LINE 共有 (Flex + PDF URL)。
  const doneButtons = pdfUrl
    ? [{ label: '見積書 PDF を開く', uri: pdfUrl, style: 'primary' as const }]
    : [];
  await safeReply(ctx, [
    buildAckBubble(
      'ご来店予定を承りました',
      [
        `来店予定: ${formatJstLabel(visitScheduledAtIso)}`,
        '※ ご予約ではなく来店順での対応となります。',
        pdfUrl ? '見積書 PDF を下のボタンからご確認いただけます。' : '見積書はスタッフよりご案内します。',
      ].join('\n'),
      doneButtons,
    ),
  ]);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** session が無ければ作り、patch を当てて保存する。 */
async function ensureSession(
  ctx: Pkg1Context,
  patch: (s: Pkg1State) => Pkg1State,
): Promise<Pkg1State> {
  const current = (await getPkg1Session(ctx.env as TrycleRepoEnv, ctx.lineUserId)) ?? emptyPkg1State();
  const next = patch(current);
  await upsertPkg1Session(ctx.env as TrycleRepoEnv, ctx.lineUserId, next);
  return next;
}

async function resolveCustomerName(ctx: Pkg1Context): Promise<string | null> {
  try {
    const customer = await findCustomerByLineUserId(ctx.env as TrycleRepoEnv, ctx.lineUserId);
    return customer?.name ?? null;
  } catch {
    return null;
  }
}

export function cartSummaryText(cart: ReadonlyArray<CartItem>): string {
  const lines = cart.map((item) => {
    const opt = item.option_names.length > 0 ? ` (${item.option_names.join('/')})` : '';
    const qty = item.qty > 1 ? ` ×${item.qty}` : '';
    return `・${item.name}${opt}${qty}`;
  });
  lines.push(`小計(税抜): ${cartSubtotal(cart)}円`);
  return lines.join('\n');
}

function formatJstLabel(iso: string): string {
  const d = new Date(iso);
  // iso は UTC フィールドに JST 壁時計を持つ visitAt.toISOString()。
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mo}/${day} ${hh}:${mi}`;
}

async function safeReply(ctx: Pkg1Context, messages: Array<FlexMessage | { type: 'text'; text: string }>): Promise<void> {
  try {
    await ctx.lineClient.replyMessage(ctx.replyToken, messages as never);
  } catch (err) {
    console.error('[trycle-pkg1] reply failed', err);
  }
}
