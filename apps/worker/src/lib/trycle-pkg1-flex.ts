/**
 * TRYCLE Pkg1 (整備見積) メッセージ builders (本物モデル・状態を持たない純関数)。
 *
 * 本物 trycle-line-harness/src/flows/pkg1-messages.ts + reservation-flow.ts の
 * presentation 層を port:
 *   dispatchPrompt / regionMessages (9 部位 Carousel) / symptomMessages (3/列 Carousel)
 *   / variantMessages (≤4 Buttons / ≥5 Carousel) / qtyPrompt (pair/count・v1.2.1 で
 *   3 本以上ボタン削除) / cartDecisionPrompt / confirmMessages (PDF だけ / 来店予定 /
 *   やり直す) / cartSummaryText / consentPrompt (LIFF URI) / storeCarousel /
 *   datetimePickerMessage / reservationConfirmPrompt。
 *
 * postback 命名は本物 `pkg1_X&value=Y` 形式 (設計 v1.2.1 §3)。
 * LINE テンプレート制約: Buttons actions ≤ 4 / Carousel columns ≤ 10 /
 * Carousel column の actions ≤ 3。
 *
 * 設計: Pkg1 詳細設計 v1.2.1 §3 (page 386050ad6a7e81f8b701cd52c9201af6)。
 */
import type { Region, Symptom, Variant } from '../data/pkg1-regions.js';
import { buildQuote, formatQuoteText, type QuoteLineItem } from './quote.js';
import type { StoreRow } from './trycle-repo.js';

// LINE メッセージ最小型 (LineClient へ渡す配列要素)。本物の messagingApi 互換。
export interface LineMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

export const MAX_REPLY_MESSAGES = 5;
const BUTTONS_MAX_ACTIONS = 4;
const CAROUSEL_MAX_COLUMNS = 10;
const CAROUSEL_ACTIONS_PER_COLUMN = 3;

export type Dispatch = 'identified' | 'comprehensive' | 'unknown';

/** 状況ふりわけ 3 択のラベル (本物 DISPATCH_LABELS と一致・文言厳守)。 */
export const DISPATCH_LABELS: Readonly<Record<Dispatch, string>> = {
  identified: '原因特定済み',
  comprehensive: '包括メンテしたい',
  unknown: '原因がわからない',
};

// ── 共通 ─────────────────────────────────────────────────────────────────────

/** LINE のボタン label は 20 文字上限。超過は切り詰める。 */
export function truncateLabel(label: string, max = 20): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

export function textMessage(text: string): LineMessage {
  return { type: 'text', text };
}

// ── ① 状況ふりわけ 3 択 (REQ-PKG1-002) ───────────────────────────────────────

export function dispatchPrompt(): LineMessage {
  return {
    type: 'template',
    altText: '整備のご相談・状況をお選びください',
    template: {
      type: 'buttons',
      title: '整備見積もり',
      text: 'まず、いまの状況に近いものをお選びください。',
      actions: (Object.keys(DISPATCH_LABELS) as Dispatch[]).map((key) => ({
        type: 'postback',
        label: DISPATCH_LABELS[key],
        data: `action=pkg1_dispatch&value=${key}`,
        displayText: DISPATCH_LABELS[key],
      })),
    },
  };
}

// ── ② 部位 (region) 選択 — 9 部位 Carousel (REQ-PKG1-004) ─────────────────────

export function regionMessages(regions: ReadonlyArray<Region>): LineMessage[] {
  const columns = regions.slice(0, CAROUSEL_MAX_COLUMNS).map((region) => ({
    title: truncateLabel(region.label, 40),
    text: '整備したい部位',
    actions: [
      {
        type: 'postback',
        label: '選ぶ',
        data: `action=pkg1_region&value=${region.value}`,
        displayText: region.label,
      },
    ],
  }));
  return [
    {
      type: 'template',
      altText: '整備したい部位をお選びください',
      template: { type: 'carousel', columns },
    },
  ];
}

// ── ③ 作業 (symptom) 選択 — Carousel に分割 (column ごとに 3 ボタン) ─────────────

export function symptomMessages(region: Region): LineMessage[] {
  const symptoms = region.symptoms ?? [];
  const columns: object[] = [];
  for (let i = 0; i < symptoms.length; i += CAROUSEL_ACTIONS_PER_COLUMN) {
    const chunk = symptoms.slice(i, i + CAROUSEL_ACTIONS_PER_COLUMN);
    columns.push({
      title: truncateLabel(region.label, 40),
      text: '作業メニューをお選びください',
      actions: chunk.map((symptom, j) => symptomAction(symptom, i + j)),
    });
    if (columns.length >= CAROUSEL_MAX_COLUMNS) break;
  }
  return [
    {
      type: 'template',
      altText: `${region.label}の作業メニュー`,
      template: { type: 'carousel', columns },
    },
  ];
}

function symptomAction(symptom: Symptom, index: number): object {
  return {
    type: 'postback',
    label: truncateLabel(symptom.label),
    data: `action=pkg1_symptom&value=${index}`,
    displayText: symptom.label,
  };
}

// ── 種類 (variant) 選択 — 4 件以下 Buttons / 5 件以上 Carousel ──────────────────

export function variantMessages(symptom: Symptom): LineMessage[] {
  const variants = symptom.variants ?? [];
  if (variants.length <= BUTTONS_MAX_ACTIONS) {
    return [
      {
        type: 'template',
        altText: `${symptom.label}の種類をお選びください`,
        template: {
          type: 'buttons',
          title: truncateLabel(symptom.label, 40),
          text: '種類をお選びください',
          actions: variants.map((variant, i) => variantAction(variant, i)),
        },
      },
    ];
  }
  const columns: object[] = [];
  for (let i = 0; i < variants.length; i += CAROUSEL_ACTIONS_PER_COLUMN) {
    const chunk = variants.slice(i, i + CAROUSEL_ACTIONS_PER_COLUMN);
    columns.push({
      title: truncateLabel(symptom.label, 40),
      text: '種類をお選びください',
      actions: chunk.map((variant, j) => variantAction(variant, i + j)),
    });
  }
  return [
    {
      type: 'template',
      altText: `${symptom.label}の種類をお選びください`,
      template: { type: 'carousel', columns: columns.slice(0, CAROUSEL_MAX_COLUMNS) },
    },
  ];
}

function variantAction(variant: Variant, index: number): object {
  return {
    type: 'postback',
    label: truncateLabel(variant.label),
    data: `action=pkg1_variant&value=${index}`,
    displayText: variant.label,
  };
}

// ── 数量 (qty) 選択 — v1.2.1: 3 本以上ボタン削除・任意数量は text 受付 ──────────

export function qtyPrompt(symptom: Symptom): LineMessage {
  const actions: object[] =
    symptom.qty === 'pair'
      ? [qtyAction('前後セット（2本/両側）', '2'), qtyAction('1本/片側のみ', '1')]
      : [qtyAction('1本', '1'), qtyAction('2本', '2')];
  return {
    type: 'template',
    altText: '数量をお選びください',
    template: {
      type: 'buttons',
      title: '数量の確認',
      // v1.2.1: 3 本以上はボタンを出さず、任意の本数を数字で送ってもらう。
      text: `${truncateLabel(symptom.label, 24)}の数量をお選びください。\n3本以上は本数を数字でお送りください。`,
      actions,
    },
  };
}

function qtyAction(label: string, value: string): object {
  return {
    type: 'postback',
    label: truncateLabel(label),
    data: `action=pkg1_qty&value=${value}`,
    displayText: label,
  };
}

// ── カート: 追加 or 確認へ (REQ-PKG1-008 / 021) ───────────────────────────────

export function cartDecisionPrompt(): LineMessage {
  return {
    type: 'template',
    altText: 'ほかの整備も追加しますか？',
    template: {
      type: 'buttons',
      title: 'お見積もり内容',
      text: 'ほかの整備も追加できます。',
      actions: [
        {
          type: 'postback',
          label: '➕ 他の整備も追加',
          data: 'action=pkg1_cart&value=add',
          displayText: '他の整備も追加',
        },
        {
          type: 'postback',
          label: '✅ 確認へ進む',
          data: 'action=pkg1_cart&value=confirm',
          displayText: '確認へ進む',
        },
      ],
    },
  };
}

// ── 確認 (REQ-PKG1-009 概算明示) → 3 択 (本物 confirmMessages) ─────────────────

export function confirmMessages(cart: ReadonlyArray<QuoteLineItem>): LineMessage[] {
  const quote = buildQuote(cart);
  return [
    textMessage(formatQuoteText(quote)),
    {
      type: 'template',
      altText: 'この内容でよろしいですか？',
      template: {
        type: 'buttons',
        title: 'ご確認',
        text: '上記の内容で次にどうしますか？',
        actions: [
          {
            type: 'postback',
            label: 'PDF だけ受け取る',
            data: 'action=pkg1_confirm&value=pdf_only',
            displayText: 'PDF だけ受け取る',
          },
          {
            // TRYCLE は来店順対応のため文言は「来店予定」(本物ラベル「来店予約」を調整)。
            type: 'postback',
            label: 'ご来店予定を伝える',
            data: 'action=pkg1_confirm&value=reserve',
            displayText: 'ご来店予定を伝える',
          },
          {
            type: 'postback',
            label: 'やり直す',
            data: 'action=pkg1_confirm&value=redo',
            displayText: 'やり直す',
          },
        ],
      },
    },
  ];
}

// ── 同意書ゲート (Add-B・REQ-PKG1-016) — LIFF URI ボタン ───────────────────────

export function consentPrompt(liffUrl: string | undefined): LineMessage {
  if (!liffUrl) {
    // fail-loud: LIFF URL 未投入時は URI ボタンを出さず、スタッフ折り返しに倒す。
    return {
      type: 'template',
      altText: '整備同意書 (準備中)',
      template: {
        type: 'buttons',
        title: '整備同意書',
        text: '同意書フォームは現在準備中です。スタッフよりご連絡いたします。',
        actions: [{ type: 'message', label: '了解しました', text: '了解しました' }],
      },
    };
  }
  return {
    type: 'template',
    altText: '整備同意書のご確認',
    template: {
      type: 'buttons',
      title: '整備同意書',
      text: 'ご来店前に整備同意書のご記入をお願いします。\nお名前・電話番号もこちらでお預かりします。',
      actions: [{ type: 'uri', label: '同意書を開く', uri: liffUrl }],
    },
  };
}

// ── カートサマリ (text) ───────────────────────────────────────────────────────

export function cartSummaryText(cart: ReadonlyArray<QuoteLineItem>): string {
  const quote = buildQuote(cart);
  return `カートに追加しました（${cart.length}件）\n\n${formatQuoteText(quote)}`;
}

// ── 来店予定: 店舗選択 Carousel (本物 reservation-flow storeCarousel) ───────────

export function storeCarousel(stores: ReadonlyArray<StoreRow>): LineMessage {
  const columns = stores.slice(0, CAROUSEL_MAX_COLUMNS).map((s) => ({
    title: truncateLabel(s.name, 40),
    text: '来店店舗を選ぶ',
    actions: [
      {
        type: 'postback',
        label: '選ぶ',
        data: `action=pkg1_reserve_store&value=${s.id}`,
        displayText: s.name,
      },
    ],
  }));
  return {
    type: 'template',
    altText: '来店店舗をお選びください',
    template: { type: 'carousel', columns },
  };
}

// ── 来店予定: 日時 datetimepicker (本物 datetimePickerMessage・14 日先) ──────────

const RESERVATION_HORIZON_DAYS = 14;

export function datetimePickerMessage(store: StoreRow): LineMessage {
  const today = new Date();
  const min = formatDatetimePickerValue(today);
  const max = formatDatetimePickerValue(
    new Date(today.getTime() + RESERVATION_HORIZON_DAYS * 24 * 3600 * 1000),
  );
  const slot = store.reservation_slot_minutes > 0 ? store.reservation_slot_minutes : 30;
  return {
    type: 'template',
    altText: '来店予定日時をお選びください',
    template: {
      type: 'buttons',
      title: truncateLabel(store.name, 40),
      text: `${RESERVATION_HORIZON_DAYS}日先まで・${slot}分刻みで選べます`,
      actions: [
        {
          type: 'datetimepicker',
          label: '日時を選ぶ',
          data: 'action=pkg1_reserve_dt',
          mode: 'datetime',
          initial: min,
          min,
          max,
        },
      ],
    },
  };
}

// ── 来店予定: 確認 Buttons (はい / 別の日時にする) ──────────────────────────────

export function reservationConfirmPrompt(storeName: string, visitAtIso: string): LineMessage {
  const human = formatVisitAt(visitAtIso);
  return {
    type: 'template',
    altText: '来店予定の確認',
    template: {
      type: 'buttons',
      title: 'ご確認',
      text: `${truncateLabel(storeName, 30)} に ${human} 来店予定でよろしいですか？`,
      actions: [
        {
          type: 'postback',
          label: 'はい',
          data: 'action=pkg1_reserve_confirm&value=ok',
          displayText: 'はい',
        },
        {
          type: 'postback',
          label: '別の日時にする',
          data: 'action=pkg1_reserve_confirm&value=change',
          displayText: '別の日時にする',
        },
      ],
    },
  };
}

// ── 日時整形 (本物 reservation-flow と同一・JST 壁時計を文字列で扱う) ───────────

/** LINE datetimepicker の initial/min/max は "YYYY-MM-DDtHH:mm" 形式。 */
function formatDatetimePickerValue(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}t${hh}:${mi}`;
}

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
