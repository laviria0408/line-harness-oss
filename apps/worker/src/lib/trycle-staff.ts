/**
 * スタッフ引き継ぎ通知 + 問い合わせ振り分け (REQ-PKG1-017 / 024 / Add-D / Add-F)。
 *
 * スタッフ相談 / 有人切替時に、店舗スタッフへ会話の引き継ぎを Gmail で送る。
 * 同梱物 = 顧客情報 + (見積中なら) 見積サマリ + 見積 PDF URL + 自動タグ + 振り分け店舗。
 * 送信は個別維持 GAS (callGas gmail_notify)。宛先は env GMAIL_NOTIFICATION_TO。
 *
 * Add-D / Add-F (本物 shop-routing.ts port):
 *   - classifyInquiry(text): 問い合わせ種別を 8 tag に自動分類 (キーワード一致・AI なし)
 *   - routeInquiry(tag): カーボン補修=矢野口固定・それ以外は希望店舗 (既定 yano)
 *   - shopLabel(shop): 店舗 id → 表示名
 *
 * 設計: Pkg1 詳細設計 v1.2.1 §3 経路 A/D (page 386050ad6a7e81f8b701cd52c9201af6)。
 */
import type { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../index.js';
import { callGas, sendMail } from './trycle-gas-client.js';
import { recordOutgoingMessages, type OutgoingLogEnv } from './trycle-outgoing-log.js';
import type { TrycleRepoEnv } from './trycle-repo.js';
import { findCustomerByLineUserId } from './trycle-repo.js';
import { setManualMode } from './trycle-session.js';
import {
  resolveCaseStaffConsult,
  type NotifyResolution,
} from './trycle-notify-rules.js';
import {
  createStaffConsultCase,
  findLatestCaseByLineUserId,
  markCaseTalking,
  insertNotification,
  type CaseRef,
} from './trycle-staff-repo.js';
import {
  getStaffConsult,
  setStaffConsult,
  clearStaffConsult,
  STAFF_CONSULT_MAX_APPEND,
  STAFF_CONSULT_CONFIRM_DEBOUNCE_MS,
  type StaffConsultState,
  type StaffConsultSource,
} from './trycle-staff-session.js';
import {
  buildTapRow,
  buildSectionLabel,
  TRYCLE_GREEN,
  TEXT_PRIMARY,
  TEXT_MUTED,
  type FlexMessage,
} from './trycle-flex-helpers.js';

// ── Add-D / Add-F: 問い合わせ分類 + 店舗振り分け (本物 shop-routing.ts) ─────────

export type ShopId = 'yano' | 'miyagase';
export type InquiryTag =
  | 'estimate'
  | 'reservation'
  | 'faq'
  | 'consult'
  | 'carbon'
  | 'wage'
  | 'consent'
  | 'other';

export interface RoutingResult {
  readonly shopId: ShopId;
  readonly tag: InquiryTag;
  readonly staffEmailKey: 'yano_staff' | 'miyagase_staff' | 'head_office';
  readonly reason: string;
}

const YANO_ONLY_TAGS: ReadonlySet<InquiryTag> = new Set(['carbon']);

/**
 * REQ-ADD-D-001: 問い合わせ種別の自動タグ付け (キーワード一致・AI なし)。
 * 順序が重要: 「工賃表」を「工賃」(estimate) より先に判定。
 */
export function classifyInquiry(text: string): InquiryTag {
  const lower = text.toLowerCase();
  if (/カーボン|carbon|フレーム補修|フレームクラック/i.test(text)) return 'carbon';
  if (/工賃表/i.test(text)) return 'wage';
  if (/同意書|consent/i.test(lower)) return 'consent';
  if (/見積|工賃|整備/i.test(text)) return 'estimate';
  if (/予約|来店|booking|reserv/i.test(lower)) return 'reservation';
  if (/faq|よくある質問/i.test(lower)) return 'faq';
  if (/相談|スタッフ|staff|consult/i.test(lower)) return 'consult';
  return 'other';
}

/**
 * REQ-ADD-F-002 / REQ-ADD-D-002: tag + 希望店舗から対応店舗 + 担当者キーを決定。
 * カーボン補修は希望に関わらず矢野口固定。それ以外は preferredShop (既定 yano)。
 */
export function routeInquiry(tag: InquiryTag, preferredShop?: ShopId): RoutingResult {
  const wantsYano = YANO_ONLY_TAGS.has(tag);
  const shopId: ShopId = wantsYano ? 'yano' : preferredShop ?? 'yano';
  const staffEmailKey: RoutingResult['staffEmailKey'] =
    shopId === 'yano' ? 'yano_staff' : 'miyagase_staff';
  const reason = wantsYano
    ? 'カーボン補修は矢野口本店のみ対応 (REQ-ADD-F-002)'
    : `tag=${tag} を ${shopId} 店舗担当へ振り分け`;
  return { shopId, tag, staffEmailKey, reason };
}

/** Shop ID → 表示名 (店舗情報付与 REQ-ADD-F-001)。 */
export function shopLabel(id: ShopId): string {
  return id === 'yano' ? '矢野口本店' : '宮ヶ瀬店';
}

// ── スタッフ通知 ──────────────────────────────────────────────────────────────

export interface StaffNotifyInput {
  readonly lineUserId: string;
  /** 顧客表示名 (customers.name)。未取得なら null。 */
  readonly customerName: string | null;
  /** 相談のきっかけ ('包括メンテ' / '確定不能症状' / '来店予定の受付' 等)。 */
  readonly reason: string;
  /** 見積サマリ (cart があれば。無ければ null)。 */
  readonly estimateSummary: string | null;
  /** 見積 PDF URL (発行済なら)。 */
  readonly pdfUrl: string | null;
  /** 会話 sketch (任意・短い要約)。 */
  readonly note: string | null;
  /** 自動分類のもとにする本文 (なければ reason)。 */
  readonly inquiryText?: string;
  /** 希望店舗 (任意)。 */
  readonly preferredShop?: ShopId;
}

export interface StaffNotifyResult {
  readonly ok: boolean;
  readonly tag: InquiryTag;
  readonly shopId: ShopId;
  readonly error?: string;
}

/**
 * スタッフへ Gmail 通知を送る。GMAIL_NOTIFICATION_TO / GAS_WEB_APP_URL 未設定なら
 * no-op で ok=false を返す (呼び出し側は user 応答を止めない)。
 * 自動タグ (Add-D) + 店舗振り分け (Add-F) を payload + 本文に同梱する。
 */
export async function notifyStaff(
  env: Env['Bindings'],
  input: StaffNotifyInput,
): Promise<StaffNotifyResult> {
  const tag = classifyInquiry(input.inquiryText ?? input.reason);
  const routing = routeInquiry(tag, input.preferredShop);

  const to = env.GMAIL_NOTIFICATION_TO;
  if (!to) {
    return { ok: false, tag, shopId: routing.shopId, error: 'GMAIL_NOTIFICATION_TO not configured' };
  }
  const subject = `[TRYCLE] スタッフ相談リクエスト (${input.reason}・${shopLabel(routing.shopId)})`;
  const body = buildStaffEmailBody(input, routing);
  try {
    const res = await callGas(env, {
      type: 'gmail_notify',
      payload: {
        kind: 'staff_consult',
        to,
        subject,
        body,
        line_user_id: input.lineUserId,
        pdf_url: input.pdfUrl,
        tag,
        shop_id: routing.shopId,
        shop_label: shopLabel(routing.shopId),
        staff_email_key: routing.staffEmailKey,
        ts: new Date().toISOString(),
      },
    });
    return res.ok
      ? { ok: true, tag, shopId: routing.shopId }
      : { ok: false, tag, shopId: routing.shopId, error: res.error };
  } catch (err) {
    return {
      ok: false,
      tag,
      shopId: routing.shopId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** スタッフ向けメール本文を組む (機密値はコードに埋めない・実体は実行時の入力)。 */
export function buildStaffEmailBody(
  input: StaffNotifyInput,
  routing: RoutingResult,
): string {
  const lines: string[] = [
    'LINE からスタッフ相談のリクエストがありました。',
    '',
    `■ お客様: ${input.customerName ?? '(名前未取得)'}`,
    `■ LINE userId: ${input.lineUserId}`,
    `■ きっかけ: ${input.reason}`,
    `■ 種別タグ: ${routing.tag}`,
    `■ 対応店舗: ${shopLabel(routing.shopId)}`,
  ];
  if (input.estimateSummary) {
    lines.push('', '■ 見積サマリ', input.estimateSummary);
  }
  if (input.pdfUrl) {
    lines.push('', `■ 見積 PDF: ${input.pdfUrl}`);
  }
  if (input.note) {
    lines.push('', '■ メモ', input.note);
  }
  lines.push(
    '',
    '※ このお客様は有人モードに切り替わっています。LINE 個別チャットでご対応ください。',
    '※ お客様がリッチメニューを押すと bot 自動応答に復帰します。',
  );
  return lines.join('\n');
}

// ── スタッフ通知 二重発火 (Phase 4・dashboard + Gmail) ─────────────────────────
//
// 通知ルール (tenants.settings.notifyRules.caseStaffConsult) を参照し、案件の担当
// 有無で通知先を解決して dashboard (notifications row) + email (GAS Gmail) の両方を
// 発火する。case を相談中 (talking) に遷移させる。
//   設計: Pkg8 v2.4 (385050ad...) + dashboard Phase 3。

export interface StaffConsultNotifyInput {
  readonly lineUserId: string;
  /** 顧客表示名 (未取得なら null)。 */
  readonly customerName: string | null;
  /** 相談本文 (顧客の自由文・確認済み内容)。 */
  readonly inquiryContent: string;
  /** 起点 (pkg1 / pkg8)。 */
  readonly source: StaffConsultSource;
  /** きっかけ (例: お悩み相談 / FAQ スタッフ相談)。通知タイトル補助。 */
  readonly reason: string;
}

export interface StaffConsultNotifyResult {
  readonly ok: boolean;
  /** dashboard 通知を作った件数。 */
  readonly dashboardCount: number;
  /** email を送った件数。 */
  readonly emailCount: number;
  /** 案件を相談中に遷移できたか (案件 / talking status 無しなら false)。 */
  readonly caseMarked: boolean;
}

/**
 * case-detail への deep link を組む。DASHBOARD_PUBLIC_URL があれば `{base}/cases/<id>`、
 * 無ければ null (メール本文に link 行を出さない)。URL に token は載せない。
 */
function caseDetailUrl(env: Env['Bindings'], caseId: string | null): string | null {
  const base = env.DASHBOARD_PUBLIC_URL?.replace(/\/+$/, '');
  if (!base || !caseId) return null;
  return `${base}/cases/${caseId}`;
}

/** スタッフ向け相談メール本文 (機密: line_user_id 生値 / token は載せない)。 */
export function buildConsultEmailBody(
  input: StaffConsultNotifyInput,
  caseUrl: string | null,
): string {
  const lines: string[] = [
    'いつもお疲れさまです。',
    '',
    `お客様（${input.customerName ?? '名前未取得'} 様）からスタッフへのご相談が入っています。`,
    '',
    `■ きっかけ: ${input.reason}`,
    '■ ご相談内容:',
    input.inquiryContent,
  ];
  if (caseUrl) {
    lines.push('', `dashboard で確認: ${caseUrl}`);
  }
  lines.push(
    '',
    '----',
    'このメールは TRYCLE bot から自動送信されています。',
  );
  return lines.join('\n');
}

function buildConsultEmailSubject(input: StaffConsultNotifyInput, caseId: string | null): string {
  const idPart = caseId ? `${caseId.slice(0, 8)} ` : '';
  const namePart = input.customerName ?? 'お客様';
  return `【TRYCLE 相談中】${idPart}${namePart} 様`;
}

/**
 * スタッフ通知を二重発火する (dashboard 通知 + Gmail)。
 *
 * 1) 直近案件 + 通知ルールを解決 (担当有無で assigned/unassigned + owner)
 * 2) 案件を相談中 (talking) に遷移
 * 3) dashboard 通知 (notifications row) を解決済み宛先ごとに作成
 * 4) email を解決済み宛先 (email あり) ごとに送信
 *
 * 個々の失敗 (1 宛先の email 失敗等) は握り潰して残りを続行する (user フローは
 * 止めない)。全経路が no-op (Supabase / GAS 未設定) でも ok=true で返す
 * (呼び出し側は user への文言提示を継続)。
 */
export async function notifyStaffConsult(
  env: Env['Bindings'],
  input: StaffConsultNotifyInput,
): Promise<StaffConsultNotifyResult> {
  const repoEnv = env as TrycleRepoEnv;
  // 直近 case は新規 case の store/assignee 引き継ぎヒントとしてのみ参照 (既存 case の status は触らない)。
  let inherited: CaseRef | null = null;
  try {
    inherited = await findLatestCaseByLineUserId(repoEnv, input.lineUserId);
  } catch (err) {
    console.error('[trycle-staff] findLatestCaseByLineUserId failed', err);
  }

  // 顧客 (customer_id) 解決: line_user_id から既存顧客があれば紐付け (経路 E と同じパターン)。
  let customerId: string | null = null;
  try {
    const customer = await findCustomerByLineUserId(repoEnv, input.lineUserId);
    customerId = customer?.id ?? null;
  } catch (err) {
    console.error('[trycle-staff] findCustomerByLineUserId failed', err);
  }

  // **新規 case を作成** (status='talking')。既存 case (見積完了・予約済等) は不変。
  let caseRef: CaseRef | null = null;
  let caseMarked = false;
  try {
    const created = await createStaffConsultCase(repoEnv, {
      lineUserId: input.lineUserId,
      customerId,
      inquiryText: input.inquiryContent,
      inheritedStoreId: inherited?.storeId ?? null,
      inheritedAssigneeId: inherited?.assigneeId ?? null,
    });
    caseRef = {
      caseId: created.caseId,
      assigneeId: inherited?.assigneeId ?? null,
      storeId: inherited?.storeId ?? null,
    };
    caseMarked = true;
  } catch (err) {
    console.error('[trycle-staff] createStaffConsultCase failed', err);
  }

  // 通知ルール解決 (案件が無くても unassigned ルールで manager へは飛ばせる)。
  let resolution: NotifyResolution;
  try {
    resolution = await resolveCaseStaffConsult(repoEnv, {
      assigneeId: caseRef?.assigneeId ?? null,
      storeId: caseRef?.storeId ?? null,
    });
  } catch (err) {
    console.error('[trycle-staff] resolveCaseStaffConsult failed', err);
    return { ok: false, dashboardCount: 0, emailCount: 0, caseMarked };
  }

  const caseUrl = caseDetailUrl(env, caseRef?.caseId ?? null);
  const title = `相談: ${input.customerName ?? 'お客様'} 様（${input.reason}）`;
  const detail = truncateForNotification(input.inquiryContent);

  // 3) dashboard 通知
  let dashboardCount = 0;
  for (const r of resolution.dashboardRecipients) {
    try {
      await insertNotification(repoEnv, {
        title,
        detail,
        targetUserId: r.userId,
        targetStoreId: caseRef?.storeId ?? null,
        relatedCaseId: caseRef?.caseId ?? null,
      });
      dashboardCount += 1;
    } catch (err) {
      console.error('[trycle-staff] insertNotification failed', { userId: r.userId }, err);
    }
  }

  // 4) email
  const subject = buildConsultEmailSubject(input, caseRef?.caseId ?? null);
  const body = buildConsultEmailBody(input, caseUrl);
  let emailCount = 0;
  for (const r of resolution.emailRecipients) {
    if (!r.email) continue;
    try {
      const res = await sendMail(env, { to: r.email, subject, body, kind: 'staff_consult' });
      if (res.ok) emailCount += 1;
      else console.error('[trycle-staff] sendMail returned ok=false', res.error);
    } catch (err) {
      console.error('[trycle-staff] sendMail threw', err);
    }
  }

  return { ok: true, dashboardCount, emailCount, caseMarked };
}

/** 通知 detail はカードに収まる長さへ切る (生の長文をそのまま載せない)。 */
const NOTIFICATION_DETAIL_MAX = 200;
function truncateForNotification(text: string): string {
  const t = text.trim();
  return t.length > NOTIFICATION_DETAIL_MAX ? `${t.slice(0, NOTIFICATION_DETAIL_MAX)}…` : t;
}

// ── B1: スタッフ相談 内容確認ループ (Pkg8 faq_staff / Pkg1 escalate 共通) ────────
//
// 顧客が相談内容を入力 → 確認 → [はい]/[追記する] のループを回し、確定したら
// notifyStaffConsult (二重発火) + 有人モードへ。Pkg8 と Pkg1 で共通化する (仕様統一)。
//   postback: staff_consult_yes / staff_consult_append
//   設計: Pkg8 v2.4 B1。

const PREVIEW_MAX = 120;

/** スタッフ相談ループの実行 context (Pkg8Context / Pkg1Context から作る最小集合)。 */
export interface StaffConsultContext {
  readonly replyToken: string;
  readonly lineUserId: string;
  readonly lineClient: LineClient;
  readonly env: Env['Bindings'];
}

export function isStaffConsultPostback(data: string): boolean {
  return data === 'staff_consult_yes' || data === 'staff_consult_append';
}

function repoOf(ctx: StaffConsultContext): TrycleRepoEnv {
  return ctx.env as TrycleRepoEnv;
}

async function reply(
  ctx: StaffConsultContext,
  messages: ReadonlyArray<{ type: string; [key: string]: unknown }>,
  source: 'pkg1' | 'pkg8' = 'pkg1',
): Promise<void> {
  try {
    await ctx.lineClient.replyMessage(ctx.replyToken, messages as never);
    // dashboard/admin の会話履歴で bot 側 (B1 内容確認ループの応答) を表示するため
    // outgoing 記録は必須 (Pkg8 既存実装と同じく). 失敗しても LINE 送信成功は保つ。
    await recordOutgoingMessages(
      ctx.env as unknown as OutgoingLogEnv,
      ctx.lineUserId,
      messages,
      'reply',
      source,
    ).catch((err) => console.error('[trycle-staff] recordOutgoingMessages failed', err));
  } catch (err) {
    console.error('[trycle-staff] reply failed', err);
  }
}

function previewOf(content: string): string {
  const t = content.trim();
  return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX)}…` : t;
}

/**
 * 内容確認ループを開始する。inquiryText があれば「この内容で連携しますか?」確認から、
 * 無ければ「相談内容を入力してください」入力プロンプトから始める (Pkg1 / Pkg8 共通)。
 */
export async function startStaffConsult(
  ctx: StaffConsultContext,
  opts: { source: StaffConsultSource; reason: string; inquiryText?: string },
): Promise<void> {
  const seed = (opts.inquiryText ?? '').trim();
  if (seed.length > 0) {
    const state: StaffConsultState = {
      content: seed,
      appendCount: 0,
      awaiting: 'confirm',
      source: opts.source,
      reason: opts.reason,
    };
    await setStaffConsult(repoOf(ctx), ctx.lineUserId, state).catch((err) =>
      console.error('[trycle-staff] setStaffConsult (seed) failed', err),
    );
    await reply(ctx, [buildConfirmBubble(seed)]);
    return;
  }
  const state: StaffConsultState = {
    content: '',
    appendCount: 0,
    awaiting: 'input',
    source: opts.source,
    reason: opts.reason,
  };
  await setStaffConsult(repoOf(ctx), ctx.lineUserId, state).catch((err) =>
    console.error('[trycle-staff] setStaffConsult (input) failed', err),
  );
  await reply(ctx, [
    { type: 'text', text: 'スタッフに相談したい内容を入力してください。' },
  ]);
}

/**
 * テキスト受信時の内容確認ループ処理。active な staff_consult session が
 * awaiting='input' のときだけ handle する (それ以外は false で素通り)。
 * @returns true = handled (caller は他経路へ流さない)
 */
export async function handleStaffConsultText(
  ctx: StaffConsultContext,
  text: string,
): Promise<boolean> {
  const env = repoOf(ctx);
  const state = await getStaffConsult(env, ctx.lineUserId).catch((err) => {
    console.error('[trycle-staff] getStaffConsult failed', err);
    return null;
  });
  if (!state || state.awaiting !== 'input') return false;

  const incoming = text.trim();
  if (incoming.length === 0) {
    await reply(ctx, [{ type: 'text', text: 'お手数ですが、ご相談内容を文章でお送りください。' }]);
    return true;
  }
  // 初回 = content 上書き / 追記 = 既存に連結。
  const merged = state.content ? `${state.content}\n${incoming}` : incoming;
  await setStaffConsult(env, ctx.lineUserId, {
    ...state,
    content: merged,
    awaiting: 'confirm',
  }).catch((err) => console.error('[trycle-staff] setStaffConsult (merge) failed', err));
  await reply(ctx, [buildConfirmBubble(merged)]);
  return true;
}

/**
 * 内容確認ループの postback ([はい]/[追記する]) 処理。
 * @returns true = handled
 */
export async function handleStaffConsultPostback(
  ctx: StaffConsultContext,
  data: string,
): Promise<boolean> {
  if (!isStaffConsultPostback(data)) return false;
  const env = repoOf(ctx);
  const state = await getStaffConsult(env, ctx.lineUserId).catch((err) => {
    console.error('[trycle-staff] getStaffConsult (postback) failed', err);
    return null;
  });
  if (!state) {
    // session 失効 (24h 超 / 既送信)。graceful に再開導線を出す。
    await reply(ctx, [
      { type: 'text', text: 'お手数ですが、もう一度ご相談内容をお送りください。' },
    ]);
    return true;
  }

  if (data === 'staff_consult_append') {
    if (state.appendCount >= STAFF_CONSULT_MAX_APPEND) {
      // 追記上限到達 → これ以上は自動送信して staff へ。
      await finalizeConsult(ctx, state, { autoOnLimit: true });
      return true;
    }
    await setStaffConsult(env, ctx.lineUserId, {
      ...state,
      appendCount: state.appendCount + 1,
      awaiting: 'input',
    }).catch((err) => console.error('[trycle-staff] setStaffConsult (append) failed', err));
    await reply(ctx, [{ type: 'text', text: '追加で書きたい内容を入力してください。' }]);
    return true;
  }

  // data === 'staff_consult_yes'
  // 連打 debounce: 直近確定から 3s 以内の 2 回目は silent (session は確定で消える
  // ため、ここに来る連打は概ね webhook retry / ダブルタップ)。
  if (state.lastConfirmAt) {
    const elapsed = Date.now() - new Date(state.lastConfirmAt).getTime();
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= STAFF_CONSULT_CONFIRM_DEBOUNCE_MS) {
      return true; // silent
    }
  }
  await finalizeConsult(ctx, state, { autoOnLimit: false });
  return true;
}

/**
 * 相談内容を確定して staff へ送る (二重発火 + 有人モード + session クリア)。
 * autoOnLimit = 追記上限到達による自動送信 (文言を変える)。
 */
async function finalizeConsult(
  ctx: StaffConsultContext,
  state: StaffConsultState,
  opts: { autoOnLimit: boolean },
): Promise<void> {
  const env = repoOf(ctx);
  // 連打 debounce 用に最終確定時刻を残してから送る (送信中の 2 回目を弾く)。
  await setStaffConsult(env, ctx.lineUserId, {
    ...state,
    lastConfirmAt: new Date().toISOString(),
  }).catch(() => undefined);

  const customerName = await resolveConsultCustomerName(env, ctx.lineUserId);

  const result = await notifyStaffConsult(ctx.env, {
    lineUserId: ctx.lineUserId,
    customerName,
    inquiryContent: state.content,
    source: state.source,
    reason: state.reason,
  }).catch((err) => {
    console.error('[trycle-staff] notifyStaffConsult failed', err);
    return null;
  });

  // 有人モードへ (bot 自動応答を一時停止・リッチメニューで復帰)。
  await setManualMode(env, ctx.lineUserId).catch((err) =>
    console.error('[trycle-staff] setManualMode failed', err),
  );

  // session は確定で消す (以降の text/postback は新規相談として扱う)。
  await clearStaffConsult(env, ctx.lineUserId).catch((err) =>
    console.error('[trycle-staff] clearStaffConsult failed', err),
  );

  const head = opts.autoOnLimit
    ? 'ご相談内容をスタッフに送信しました。これ以上の追記はスタッフへ直接お伝えください。'
    : 'ご相談内容をスタッフに送信しました。';
  const tail =
    result && (result.dashboardCount > 0 || result.emailCount > 0 || result.caseMarked)
      ? 'この後はスタッフが直接ご対応します。ご返信まで少々お待ちください。'
      : 'スタッフが確認のうえご連絡いたします。少々お待ちください。';
  await reply(ctx, [{ type: 'text', text: `${head}\n${tail}` }]);
}

async function resolveConsultCustomerName(
  env: TrycleRepoEnv,
  lineUserId: string,
): Promise<string | null> {
  try {
    const customer = await findCustomerByLineUserId(env, lineUserId);
    return customer?.name ?? null;
  } catch (err) {
    console.error('[trycle-staff] resolveConsultCustomerName failed', err);
    return null;
  }
}

/** 内容確認 Bubble ([はい]/[追記する])。入力プレビュー付き。 */
function buildConfirmBubble(content: string): FlexMessage {
  return {
    type: 'flex',
    altText: 'スタッフへの連携内容の確認',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        backgroundColor: TRYCLE_GREEN,
        contents: [
          {
            type: 'text',
            text: 'この内容でスタッフに連携してよろしいですか？',
            size: 'md',
            weight: 'bold',
            color: '#ffffff',
            wrap: true,
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: '▼ ご相談内容', size: 'xs', color: TEXT_MUTED },
          {
            type: 'text',
            text: previewOf(content),
            size: 'sm',
            color: TEXT_PRIMARY,
            wrap: true,
            margin: 'sm',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'lg',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: TRYCLE_GREEN,
            height: 'sm',
            action: { type: 'postback', label: 'はい', data: 'staff_consult_yes' },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: { type: 'postback', label: '追記する', data: 'staff_consult_append' },
          },
        ],
      },
    },
  };
}

// ── Pkg1 からのスタッフ相談 entry ────────────────────────────────────────────
//
// subagent A の Pkg1 escalate が「スタッフに相談する」を選んだ時に呼ぶ。B1 と同じ
// 内容確認ループを通す (Pkg1 + Pkg8 でスタッフ相談フロー統一)。

/**
 * Pkg1 からスタッフ相談ループを開始する。
 * - inquiryText が空 → 「相談内容を入力してください」入力から開始
 * - inquiryText あり → 「この内容で連携しますか?」確認から開始
 *
 * @param ctx        Pkg1 側の最小 context (replyToken / lineUserId / lineClient / env)
 * @param inquiryText 顧客の自由文 (お悩み入力 / 0 件マッチ後の追加入力)。空可。
 * @param reason     通知のきっかけ文言 (省略時は 'スタッフ相談')。
 */
export async function startStaffConsultFromPkg1(
  ctx: StaffConsultContext,
  inquiryText: string,
  reason = 'スタッフ相談',
): Promise<void> {
  await startStaffConsult(ctx, { source: 'pkg1', reason, inquiryText });
}
