/**
 * TRYCLE Pkg1 / Pkg8 postback の「人間可読ラベル」解決 (Phase 2・会話履歴の完全文脈化)。
 *
 * ## なぜ要るか
 * webhook は postback の raw data (`action=pkg1_symptom&value=5`) を messages_log に
 * incoming として保存する。これを案件詳細「会話履歴」でそのまま出すと「#5」が raw 番号
 * のまま漏れ、何を選んだか読めない。dashboard 側 conversation-display.ts でも翻訳して
 * いるが、`pkg1_symptom=5` のような **session 依存 index** は UI 側だけでは region 文脈
 * が無く `作業を選択 (5)` までしか出せない。
 *
 * そこで bot 側 (region 文脈 = bot_sessions を持つ) で 1 度だけ実ラベルへ翻訳し、
 * messages_log の incoming content を翻訳済みラベルに置換する (Method A・DRY)。
 * 表示側 (dashboard / LH 管理画面) は保存済みの整形済みテキストを素通しできる。
 *
 * ## 解決の入力
 * - region/symptom/variant の固定カタログ … `data/pkg1-regions.ts`
 * - index → 実体の解決に要る region 文脈 … 呼び出し側が渡す `regionValue`
 *   (postback 処理「前」の session.pending.regionValue。処理後は session が進むため)
 * - 店舗名 … 呼び出し側が `storeNameById` で引けるよう関数注入 (DB 依存を本 module から排除)
 *
 * 出力は `[操作] 「シーラント注入（1本）」を選択` のような表示用テキスト。Pkg1 postback で
 * なければ null (= 翻訳不要・raw のまま)。
 */
import { findRegionByValue } from '../data/pkg1-regions.js';
import { DISPATCH_LABELS, formatVisitAt, type Dispatch } from './trycle-pkg1-flex.js';

/** カート操作。 */
const CART_LABELS: Readonly<Record<string, string>> = {
  add: '他の整備も追加',
  confirm: '確認へ進む',
};

/** 見積確認後の分岐。 */
const CONFIRM_LABELS: Readonly<Record<string, string>> = {
  pdf_only: 'PDF だけ受け取る',
  reserve: 'ご来店予定を伝える',
  redo: 'やり直す',
};

/** 予約確定の分岐。 */
const RESERVE_CONFIRM_LABELS: Readonly<Record<string, string>> = {
  ok: 'はい（予約確定）',
  change: '別の日時にする',
};

/** action 名 (value 非依存) の入口・メニュー系。 */
const BARE_ACTION_LABELS: Readonly<Record<string, string>> = {
  pkg1_start: '整備見積もりを始める',
  pkg1_wage: '工賃の確認',
  pkg1_staff: 'スタッフに相談',
  pkg8_start: 'よくある質問',
  faq_start: 'よくある質問',
  // Phase 4 各種予約 3 分岐 + 来店予定ゲート。
  reservation_start: '各種予約を開く',
  reservation_stores: '洗車・試乗・フィッティング（STORES）を選択',
  reservation_maintenance: 'メンテナンスの予約を選択',
  reservation_visit_start: 'その他（来店予約）を選択',
  reservation_visit_skip: 'ご来店内容の入力をスキップ',
  // Phase 4 スタッフ相談共通フロー (B1 内容確認ループ・Pkg1 / Pkg8 共通)。
  staff_consult_yes: 'この内容でスタッフに連携',
  staff_consult_append: '相談内容に追記する',
};

/** 来店予定ゲート確定の分岐。 */
const VISIT_CONFIRM_LABELS: Readonly<Record<string, string>> = {
  ok: '予約する',
  change: '日時を変更する',
};

/**
 * postback ラベル解決の文脈。bot 側 (webhook) が postback 処理「前」に集める。
 * すべて任意 — 解決できない要素は raw value にフォールバックする。
 */
export interface PostbackLabelContext {
  /** symptom/variant の index 解決に使う region value (session.pending.regionValue)。 */
  readonly regionValue?: string;
  /** symptom index (variant 解決に使う・session.pending.symptomIndex)。 */
  readonly symptomIndex?: number;
  /** 店舗 id → 店舗名 を引く関数 (DB 依存を本 module に持ち込まないため注入)。 */
  readonly storeNameById?: (storeId: string) => Promise<string | null>;
}

/** `[操作] {body}` 形式に包む。 */
function op(body: string): string {
  return `[操作] ${body}`;
}

/** 「{label}」を選択 形式に包む。 */
function chose(label: string): string {
  return op(`「${label}」を選択`);
}

function parseAction(data: string): string {
  if (!data.includes('action=')) return data.trim();
  return new URLSearchParams(data).get('action') ?? '';
}

function parseValue(data: string): string | null {
  if (!data.includes('=')) return null;
  return new URLSearchParams(data).get('value');
}

/**
 * postback data を人間可読ラベルへ翻訳する。Pkg1/Pkg8 postback でなければ null。
 * 非同期なのは店舗名解決 (storeNameById) のため。それ以外は同期的に決まる。
 */
export async function resolvePostbackLabel(
  data: string,
  ctx: PostbackLabelContext = {},
): Promise<string | null> {
  const raw = data.trim();
  if (!raw) return null;

  // 素の action (入口・メニュー)。
  if (BARE_ACTION_LABELS[raw]) return op(BARE_ACTION_LABELS[raw]);

  const action = parseAction(raw);

  // Phase 4 各種予約: 入口 3 択 (value 非依存) + 来店予定ゲートの選択。
  if (BARE_ACTION_LABELS[action] && !raw.includes('value=')) return op(BARE_ACTION_LABELS[action]);
  if (action.startsWith('reservation_')) {
    return resolveReservationAction(action, parseValue(raw), ctx);
  }

  if (!action.startsWith('pkg1_')) return null;
  const value = parseValue(raw);

  // datetimepicker (来店日時) は value でなく postback.params.datetime で来るが、
  // value にも入る場合があるため value を優先し formatVisitAt で整形する。
  return resolveAction(action, value, ctx);
}

async function resolveAction(
  action: string,
  value: string | null,
  ctx: PostbackLabelContext,
): Promise<string | null> {
  switch (action) {
    case 'pkg1_start':
      return op(BARE_ACTION_LABELS.pkg1_start);
    case 'pkg1_wage':
      return op(BARE_ACTION_LABELS.pkg1_wage);
    case 'pkg1_dispatch':
      return resolveDispatch(value);
    case 'pkg1_region':
      return resolveRegion(value);
    case 'pkg1_symptom':
      return resolveSymptom(value, ctx);
    case 'pkg1_variant':
      return resolveVariant(value, ctx);
    case 'pkg1_qty':
      return resolveQty(value);
    case 'pkg1_option':
      return resolveOption(value);
    case 'pkg1_cart':
      return value && CART_LABELS[value] ? op(CART_LABELS[value]) : null;
    case 'pkg1_confirm':
      return value && CONFIRM_LABELS[value] ? op(CONFIRM_LABELS[value]) : null;
    case 'pkg1_reserve_store':
      return resolveStore(value, ctx);
    case 'pkg1_reserve_date':
      return value ? op(`ご来店日「${formatVisitAt(`${value}t00:00`)}」を選択`) : op('ご来店日を選択');
    case 'pkg1_reserve_time':
      return value ? op(`ご来店日時「${formatVisitAt(value)}」を選択`) : op('ご来店時間を選択');
    case 'pkg1_reserve_confirm':
      return value && RESERVE_CONFIRM_LABELS[value] ? op(RESERVE_CONFIRM_LABELS[value]) : null;
    // Phase 4 包括メンテゲート (A2): pkg1_overhaul (value=picker/matrix) と
    //                              pkg1_overhaul_menu (value=laborId・メニュー確定)。
    case 'pkg1_overhaul':
      if (value === 'picker') return op('メニューの選択に進む');
      if (value === 'matrix') return op('オーバーホールの違いを確認');
      return null;
    case 'pkg1_overhaul_menu':
      return value ? op(`包括メンテのメニューを選択`) : null;
    // Phase 4 「お悩み」マッチング (A1): value=pick:{index}/again/staff。
    case 'pkg1_osayami':
      if (value === 'again') return op('もう一度質問する');
      if (value === 'staff') return op('スタッフに相談する');
      if (value && value.startsWith('pick:')) return op('候補のメニューを選択');
      return null;
    default:
      return null; // 未知の pkg1_ postback は翻訳しない (raw のまま)。
  }
}

/** Phase 4 各種予約 / 来店予定ゲートの postback ラベル解決。 */
async function resolveReservationAction(
  action: string,
  value: string | null,
  ctx: PostbackLabelContext,
): Promise<string | null> {
  switch (action) {
    case 'reservation_visit_store':
      return resolveStore(value, ctx);
    case 'reservation_visit_date':
      return value ? op(`ご来店日「${formatVisitAt(`${value}t00:00`)}」を選択`) : op('ご来店日を選択');
    case 'reservation_visit_time':
      return value ? op(`ご来店日時「${formatVisitAt(value)}」を選択`) : op('ご来店時間を選択');
    case 'reservation_visit_confirm':
      return value && VISIT_CONFIRM_LABELS[value] ? op(VISIT_CONFIRM_LABELS[value]) : null;
    default:
      // 入口 3 択など value 非依存は BARE_ACTION_LABELS で解決済み。未知は raw。
      return BARE_ACTION_LABELS[action] ? op(BARE_ACTION_LABELS[action]) : null;
  }
}

function resolveDispatch(value: string | null): string | null {
  if (value === 'identified' || value === 'comprehensive' || value === 'unknown') {
    return chose(DISPATCH_LABELS[value as Dispatch]);
  }
  return null;
}

function resolveRegion(value: string | null): string | null {
  if (!value) return null;
  const region = findRegionByValue(value);
  return region ? chose(region.label) : null;
}

function resolveSymptom(value: string | null, ctx: PostbackLabelContext): string | null {
  const index = parseIndex(value);
  if (index === null || !ctx.regionValue) return null;
  const symptom = findRegionByValue(ctx.regionValue)?.symptoms?.[index];
  return symptom ? chose(symptom.label) : null;
}

function resolveVariant(value: string | null, ctx: PostbackLabelContext): string | null {
  const index = parseIndex(value);
  if (index === null || !ctx.regionValue || ctx.symptomIndex === undefined) return null;
  const symptom = findRegionByValue(ctx.regionValue)?.symptoms?.[ctx.symptomIndex];
  const variant = symptom?.variants?.[index];
  return variant ? chose(variant.label) : null;
}

function resolveQty(value: string | null): string | null {
  const qty = parseIndex(value);
  return qty !== null ? op(`数量「${qty}」を選択`) : null;
}

/**
 * labor_options 自動聞きの回答 (value=add:<id> / skip:<id>) を解決する。
 * option 名は DB 依存 (本 module は catalog のみ) なので操作種別だけ翻訳し、
 * 具体的なオプション名は chat_summary 側 (「オプション追加: X」) で文脈化する。
 */
function resolveOption(value: string | null): string | null {
  if (!value) return null;
  if (value.startsWith('add:')) return op('オプションを追加');
  if (value.startsWith('skip:')) return op('オプションをスキップ');
  return null;
}

async function resolveStore(value: string | null, ctx: PostbackLabelContext): Promise<string | null> {
  if (!value) return null;
  if (!ctx.storeNameById) return op('店舗を選択');
  try {
    const name = await ctx.storeNameById(value);
    return name ? chose(name) : op('店舗を選択');
  } catch {
    return op('店舗を選択');
  }
}

function parseIndex(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
