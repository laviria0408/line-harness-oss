/**
 * TRYCLE Pkg1 (整備見積) メッセージ builders (本物モデル・状態を持たない純関数)。
 *
 * 表示は Pkg8 FAQ で確立した「LH 準拠 1 Bubble 縦リスト型」(tap row + divider +
 * section label) に統一。LINE Buttons / Carousel Template は横スライダー/狭幅で
 * UX が劣るため使わない (user 指摘「LH 準拠ってした？退化してるよ？」)。共通 helper /
 * 色定数は trycle-flex-helpers.ts に集約 (Pkg8 と共有)。
 *
 * 各ステップ:
 *   dispatchPrompt (状況ふりわけ 3 択) / regionMessages (9 部位) /
 *   symptomMessages (region 配下の作業) / variantMessages (排他別単価の種類) /
 *   qtyPrompt (pair/count・v1.2.1 で任意数量は text 受付) / cartDecisionPrompt /
 *   confirmMessages (概算見積 + PDF だけ / 来店予定 / やり直す) / cartSummaryText /
 *   consentPrompt (LIFF URI) / reservationSlotMessages (来店日時候補 縦リスト・
 *   Option A: 店舗内包の 1 タップ選択) / reservationConfirmPrompt。
 *
 * postback 命名は本物 `action=pkg1_X&value=Y` 形式 (設計 v1.2.1 §3) を維持。
 * ロジック (state machine / dispatcher / postback format) は dfba733 のまま不変。
 *
 * 設計: Pkg1 詳細設計 v1.2.1 §3 (page 386050ad6a7e81f8b701cd52c9201af6)。
 */
import type { Region, Symptom, Variant } from '../data/pkg1-regions.js';
import {
  buildQuote,
  formatQuoteText,
  formatYen,
  PARTS_NOTICE,
  ESTIMATE_DISCLAIMER,
  TAX_RATE,
  type QuoteLineItem,
} from './quote.js';
import type { ReservationSlot } from './trycle-visit-slots.js';
import {
  buildTapRow,
  buildSectionLabel,
  buildDivider,
  buildListBubble,
  buildPaginatedListMessages,
  TEXT_PRIMARY,
  TEXT_MUTED,
  type FlexMessage,
} from './trycle-flex-helpers.js';

// LINE メッセージ最小型 (LineClient へ渡す配列要素)。本物の messagingApi 互換。
export interface LineMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

export const MAX_REPLY_MESSAGES = 5;

export type Dispatch = 'identified' | 'comprehensive' | 'unknown';

/** 状況ふりわけ 3 択のラベル (本物 DISPATCH_LABELS と一致・文言厳守)。 */
export const DISPATCH_LABELS: Readonly<Record<Dispatch, string>> = {
  identified: '原因特定済み',
  comprehensive: '包括メンテしたい',
  unknown: '原因がわからない',
};

// ── 共通 ─────────────────────────────────────────────────────────────────────

/** ラベルが極端に長い場合の保険 (Flex は wrap するため上限は緩め)。 */
export function truncateLabel(label: string, max = 40): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

export function textMessage(text: string): LineMessage {
  return { type: 'text', text };
}

/**
 * wrap 付きの本文テキスト行 (Bubble body 内のサマリ等に使う)。
 *
 * padding (paddingStart/End/Top/Bottom) は LINE Flex 仕様上 **box 専用** で
 * text コンポーネントには無効。text に直接付けると reply が HTTP 400 で reject
 * され、safeReply が握り潰して利用者には「無反応」に見える (qtyPrompt /
 * confirmMessages が awaiting_qty 以降で無反応になっていた真因)。padding を
 * 効かせたままにするため、text を padding 付き box でラップする。
 */
function bodyText(text: string, opts?: { muted?: boolean; size?: 'xs' | 'sm' | 'md' }): object {
  return {
    type: 'box',
    layout: 'vertical',
    paddingStart: 'md',
    paddingEnd: 'md',
    paddingTop: 'sm',
    paddingBottom: 'sm',
    contents: [
      {
        type: 'text',
        text,
        size: opts?.size ?? 'sm',
        color: opts?.muted ? TEXT_MUTED : TEXT_PRIMARY,
        wrap: true,
      },
    ],
  };
}

// ── ① 状況ふりわけ 3 択 (REQ-PKG1-002) ───────────────────────────────────────

export function dispatchPrompt(): LineMessage {
  const contents: object[] = [buildSectionLabel('⭐ 状況に近いものを選んでください')];
  const keys = Object.keys(DISPATCH_LABELS) as Dispatch[];
  keys.forEach((key, i) => {
    contents.push(
      buildTapRow({ icon: '▸', label: DISPATCH_LABELS[key], data: `action=pkg1_dispatch&value=${key}` }),
    );
    if (i < keys.length - 1) contents.push(buildDivider());
  });
  return buildListBubble({
    altText: '整備見積もりを始めましょう',
    headerTitle: '整備見積もり',
    headerSubtitle: 'まず、いまの状況に近いものをお選びください',
    contents,
  });
}

// ── ② 部位 (region) 選択 — 9 部位 縦リスト (REQ-PKG1-004) ──────────────────────

export function regionMessages(regions: ReadonlyArray<Region>): LineMessage[] {
  const tapRows = regions.map((region) =>
    buildTapRow({ icon: '▸', label: region.label, data: `action=pkg1_region&value=${region.value}` }),
  );
  // 10KB を超えるなら carousel に自動分割 (件数が増えても silent reject させない)。
  return buildPaginatedListMessages({
    altText: 'お困りの部位を選んでください',
    headerTitle: 'お困りの部位',
    headerSubtitle: '整備したい部位をお選びください',
    leadingContents: [buildSectionLabel('🔧 お困りの部位を選んでください')],
    tapRows,
  });
}

// ── ③ 作業 (symptom) 選択 — region 配下を縦リスト (REQ-PKG1-005) ───────────────

export function symptomMessages(region: Region): LineMessage[] {
  const symptoms = region.symptoms ?? [];
  const tapRows = symptoms.map((symptom, i) =>
    buildTapRow({ icon: '▸', label: symptom.label, data: `action=pkg1_symptom&value=${i}` }),
  );
  // 「その他関係」(15 件) 等で 1 bubble が 10KB に迫るため、必要なら carousel に自動分割。
  return buildPaginatedListMessages({
    altText: `${region.label}の作業メニュー`,
    headerTitle: region.label,
    headerSubtitle: '作業内容をお選びください',
    leadingContents: [buildSectionLabel(`${region.label} - 作業を選んでください`)],
    tapRows,
  });
}

// ── 種類 (variant) 選択 — 排他別単価を縦リスト ────────────────────────────────
// 単価は dispatcher 側で labor_master (Supabase) を引いて確定するため、ここでは
// ラベルのみ表示する (flex builder は純関数・非同期 fetch しない＝ロジック不変)。

export function variantMessages(symptom: Symptom): LineMessage[] {
  const variants = symptom.variants ?? [];
  const tapRows = variants.map((variant, i) =>
    buildTapRow({ icon: '▸', label: variantLabel(variant), data: `action=pkg1_variant&value=${i}` }),
  );
  // variant は通常少数だが、件数が増えても 10KB を超えないよう carousel 自動分割に乗せる。
  return buildPaginatedListMessages({
    altText: `${symptom.label}の種類をお選びください`,
    headerTitle: symptom.label,
    headerSubtitle: '種類をお選びください',
    leadingContents: [buildSectionLabel(`${symptom.label} - 種類を選んでください`)],
    tapRows,
  });
}

/** sample=null (「その他」等) は確定額を出せないため店頭相談を明示する。 */
function variantLabel(variant: Variant): string {
  return variant.sample === null ? `${variant.label}（店頭でご相談）` : variant.label;
}

// ── 数量 (qty) 選択 — v1.2.1: 3 本以上ボタン削除・任意数量は text 受付 ──────────

interface QtyRowSpec {
  readonly label: string;
  readonly value: string;
}

export function qtyPrompt(symptom: Symptom): LineMessage {
  const rows: QtyRowSpec[] =
    symptom.qty === 'pair'
      ? [
          { label: '前後セット（2本/両側）', value: '2' },
          { label: '1本/片側のみ', value: '1' },
        ]
      : [
          { label: '1本', value: '1' },
          { label: '2本', value: '2' },
        ];
  const contents: object[] = [buildSectionLabel(`${symptom.label} - 数量をお選びください`)];
  for (const row of rows) {
    contents.push(buildTapRow({ icon: '▸', label: row.label, data: `action=pkg1_qty&value=${row.value}` }));
    contents.push(buildDivider());
  }
  // v1.2.1: 3 本以上はボタンを出さず、任意の本数を数字で送ってもらう。
  contents.push(bodyText('3本以上の場合は本数を半角数字でお送りください（例: 3）。', { muted: true }));
  return buildListBubble({
    altText: '数量をお選びください',
    headerTitle: '数量の確認',
    headerSubtitle: truncateLabel(symptom.label, 28),
    contents,
  });
}

// ── カート: 追加 or 確認へ (REQ-PKG1-008 / 021) ───────────────────────────────

export function cartDecisionPrompt(): LineMessage {
  const contents: object[] = [
    buildSectionLabel('📋 操作を選んでください'),
    buildTapRow({ icon: '➕', label: '他の整備も追加', data: 'action=pkg1_cart&value=add' }),
    buildDivider(),
    buildTapRow({ icon: '✅', label: '確認へ進む', data: 'action=pkg1_cart&value=confirm' }),
  ];
  return buildListBubble({
    altText: 'ほかの整備も追加しますか？',
    headerTitle: 'お見積もり内容',
    headerSubtitle: 'ほかの整備も追加できます',
    contents,
  });
}

// ── 確認 (REQ-PKG1-009 概算明示) → 3 択 (本物 confirmMessages) ─────────────────

export function confirmMessages(cart: ReadonlyArray<QuoteLineItem>): LineMessage[] {
  const quote = buildQuote(cart);
  const contents: object[] = [buildSectionLabel('📄 お見積もり（概算）')];

  // 明細を 1 行ずつ並べる。
  for (const item of quote.lineItems) {
    contents.push(quoteLineRow(item));
  }
  contents.push(buildDivider());

  // 小計 / 税 / 合計 (range 表示)。
  contents.push(amountRow('小計', rangeYen(quote.subtotal, quote.subtotalMax)));
  contents.push(amountRow(`消費税（${Math.round(TAX_RATE * 100)}%）`, formatYen(quote.tax)));
  contents.push(amountRow('合計', rangeYen(quote.total, quote.totalMax), { bold: true }));
  contents.push(buildDivider());

  // 注記 (パーツ代別途・概算)。
  contents.push(bodyText(PARTS_NOTICE, { muted: true, size: 'xs' }));
  contents.push(bodyText(ESTIMATE_DISCLAIMER, { muted: true, size: 'xs' }));
  contents.push(buildDivider());

  // 次の操作 3 択。
  contents.push(buildSectionLabel('次の操作を選んでください'));
  contents.push(buildTapRow({ icon: '📄', label: 'PDF だけ受け取る', data: 'action=pkg1_confirm&value=pdf_only' }));
  contents.push(buildDivider());
  contents.push(buildTapRow({ icon: '📅', label: 'ご来店予定を伝える', data: 'action=pkg1_confirm&value=reserve' }));
  contents.push(buildDivider());
  contents.push(buildTapRow({ icon: '🔄', label: 'やり直す', data: 'action=pkg1_confirm&value=redo' }));

  return [
    buildListBubble({
      altText: 'お見積もり（概算）',
      headerTitle: 'ご確認',
      headerSubtitle: '上記の内容で次にどうしますか？',
      contents,
    }),
  ];
}

/** 見積明細 1 行 (名称 ×数量 と金額を左右に)。 */
function quoteLineRow(item: QuoteLineItem): object {
  const qtyStr = item.qty > 1 ? ` ×${item.qty}` : '';
  const priceStr =
    item.amountMax !== null && item.amountMax !== item.amount
      ? rangeYen(item.amount, item.amountMax)
      : formatYen(item.amount);
  return amountRow(`${item.name}${qtyStr}`, priceStr);
}

/** ラベルと金額を左右に並べた行。 */
function amountRow(label: string, value: string, opts?: { bold?: boolean }): object {
  return {
    type: 'box',
    layout: 'horizontal',
    paddingStart: 'md',
    paddingEnd: 'md',
    paddingTop: 'sm',
    paddingBottom: 'sm',
    contents: [
      {
        type: 'text',
        text: label,
        size: 'sm',
        color: TEXT_PRIMARY,
        wrap: true,
        flex: 1,
        weight: opts?.bold ? 'bold' : 'regular',
      },
      {
        type: 'text',
        text: value,
        size: 'sm',
        color: TEXT_PRIMARY,
        align: 'end',
        flex: 0,
        weight: opts?.bold ? 'bold' : 'regular',
      },
    ],
  };
}

function rangeYen(min: number, max: number): string {
  return max !== min ? `${formatYen(min)}〜${formatYen(max)}` : formatYen(min);
}

// ── 同意書ゲート (Add-B・REQ-PKG1-016) — LIFF URI ボタン ───────────────────────

export function consentPrompt(liffUrl: string | undefined): LineMessage {
  if (!liffUrl) {
    // fail-loud: LIFF URL 未投入時は URI ボタンを出さず、スタッフ折り返しに倒す。
    return buildListBubble({
      altText: '整備同意書（準備中）',
      headerTitle: '整備同意書',
      headerSubtitle: '準備中です',
      contents: [
        bodyText('同意書フォームは現在準備中です。スタッフよりご連絡いたします。', { muted: true }),
      ],
    });
  }
  // URI tap row (どこをタップしても LIFF が開く)。
  const uriRow = {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    paddingTop: 'md',
    paddingBottom: 'md',
    paddingStart: 'md',
    paddingEnd: 'md',
    action: { type: 'uri', label: '同意書を開く', uri: liffUrl },
    contents: [
      { type: 'text', text: '📝', size: 'md', flex: 0 },
      {
        type: 'text',
        text: '同意書を開く',
        size: 'md',
        color: TEXT_PRIMARY,
        wrap: true,
        flex: 1,
        weight: 'bold',
      },
      { type: 'text', text: '›', size: 'lg', color: TEXT_MUTED, flex: 0, align: 'end' },
    ],
  };
  return buildListBubble({
    altText: '整備同意書のご確認',
    headerTitle: '整備同意書',
    headerSubtitle: 'ご来店前にご記入ください',
    contents: [
      bodyText(
        'ご来店前に整備同意書のご記入をお願いします。\nお名前・電話番号もこちらでお預かりします。',
        { muted: true },
      ),
      buildDivider(),
      uriRow,
    ],
  });
}

// ── カートサマリ (text) ───────────────────────────────────────────────────────

export function cartSummaryText(cart: ReadonlyArray<QuoteLineItem>): string {
  const quote = buildQuote(cart);
  return `カートに追加しました（${cart.length}件）\n\n${formatQuoteText(quote)}`;
}

// ── 来店予定: 日時候補 縦リスト (Option A・店舗内包・1 タップ選択) ────────────────
//
// 旧 UI (店舗 carousel + datetimepicker 自由カレンダー) は「分かりにくい」評価を受けた
// ため、14 日分の「日付 × 店舗 × 時刻」候補を Pkg8 LH 準拠の縦リスト (section label +
// tap row + divider) で提示する。候補が店舗を内包するので店舗選択ステップは不要。
// 候補は数百件になりうるため buildPaginatedListMessages の byte 予算 carousel 分割に乗せ、
// section label / tap row / divider を自前で組んで dividers=false で渡す。

const RESERVATION_HORIZON_DAYS = 14;

/** 1 候補の tap row。「{HH:MM} {店舗略称}」を 1 行で。postback に店舗 + 日時を内包。 */
function reservationSlotRow(slot: ReservationSlot): object {
  return buildTapRow({
    icon: '▸',
    label: `${slot.timeLabel} ${slot.storeAbbr}`,
    data: `action=pkg1_reserve_slot&value=${slot.storeId}|${slot.datetime}`,
  });
}

/**
 * 来店日時候補の縦リスト。日付ごとに section label を挟み、その配下に候補 tap row を
 * 並べる。10KB を超えるなら carousel に自動分割する (件数が増えても silent reject させない)。
 * 候補ゼロ (全店休業/枠切れ) は空配列でなく「準備中」1 Bubble を返し fail-loud にする。
 */
export function reservationSlotMessages(slots: ReadonlyArray<ReservationSlot>): LineMessage[] {
  if (slots.length === 0) {
    return [
      buildListBubble({
        altText: 'ご来店予定の候補が見つかりません',
        headerTitle: 'ご来店予定',
        headerSubtitle: '候補が見つかりませんでした',
        contents: [
          bodyText(
            'ただいまご案内できる来店枠が見つかりませんでした。スタッフよりご連絡いたします。',
            { muted: true },
          ),
        ],
      }),
    ];
  }

  // 日付が変わるたびに section label を差し込みつつ row を 1 本の配列に積む。
  // buildPaginatedListMessages の自動 divider は使わず (section label を跨ぐと不自然)、
  // 候補 row の間にだけ自前で divider を入れる。
  const rows: object[] = [];
  let prevDate: string | null = null;
  slots.forEach((slot) => {
    if (slot.date !== prevDate) {
      rows.push(buildSectionLabel(`📅 ${slot.dateLabel}`));
      prevDate = slot.date;
    } else {
      rows.push(buildDivider());
    }
    rows.push(reservationSlotRow(slot));
  });

  return buildPaginatedListMessages({
    altText: 'ご来店予定の日時をお選びください',
    headerTitle: '📅 ご来店予定',
    headerSubtitle: `${RESERVATION_HORIZON_DAYS}日先までの候補からお選びください`,
    leadingContents: [buildSectionLabel('🗓 ご希望の日時を選んでください')],
    tapRows: rows,
    dividers: false,
  });
}

// ── 来店予定: 確認 (はい / 別の日時にする) ──────────────────────────────────────

export function reservationConfirmPrompt(storeName: string, visitAtIso: string): LineMessage {
  const human = formatVisitAt(visitAtIso);
  const contents: object[] = [
    bodyText(`${storeName} に ${human} 来店予定でよろしいですか？`),
    buildDivider(),
    buildTapRow({ icon: '✅', label: 'はい', data: 'action=pkg1_reserve_confirm&value=ok' }),
    buildDivider(),
    buildTapRow({ icon: '🔄', label: '別の日時にする', data: 'action=pkg1_reserve_confirm&value=change' }),
  ];
  return buildListBubble({
    altText: '来店予定の確認',
    headerTitle: 'ご確認',
    headerSubtitle: '来店予定の内容をご確認ください',
    contents,
  });
}

// ── 日時整形 (本物 reservation-flow と同一・JST 壁時計を文字列で扱う) ───────────

export function formatVisitAt(iso: string): string {
  // iso は "YYYY-MM-DDtHH:mm" (datetimepicker) または ISO 文字列。表示用に整形する。
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})[tT](\d{2}):(\d{2})/);
  if (m) {
    const [, , mo, dd, hh, mi] = m;
    return `${Number(mo)}/${Number(dd)} ${hh}:${mi}`;
  }
  const d = new Date(iso);
  const mo = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mo}/${dd} ${hh}:${mi}`;
}

// FlexMessage 型を re-export しておく (Pkg1 専用ヘルパが要る場合に備える)。
export type { FlexMessage };
