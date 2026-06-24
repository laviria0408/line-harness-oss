/**
 * TRYCLE「各種予約」3 分岐 + 来店予定ゲートの Flex builders (本物モデル・純関数)。
 *
 * リッチメニュー「各種予約」を押すと最初に出す 3 択 (reservationMenuPrompt) と、
 * 「その他 (車体購入相談・初回相談など)」を選んだあとの来店予定ゲートで使う Flex
 * (storesLinkPrompt / visitInquiryPrompt / visitConfirmPrompt) をここに集約する。
 *
 * 表示スタイルは Pkg1 / Pkg8 で確立した「LH 準拠 1 Bubble 縦リスト型」(buildTapRow +
 * buildSectionLabel + buildDivider) に統一する (trycle-flex-helpers.ts 共有)。日付/時間
 * 選択は Pkg1 来店予定の reservationDateList / reservationTimeList を流用するため、ここ
 * には日時候補 Flex を再実装しない (DRY)。
 *
 * postback 命名:
 *   - reservation_start                      … リッチメニュー「各種予約」タップ
 *   - reservation_stores                     … 洗車・試乗・フィッティング → STORES
 *   - reservation_maintenance                … メンテナンス → Pkg1 通常フロー
 *   - reservation_visit_start                … その他 → 来店予定ゲート開始
 *   - reservation_visit_skip                 … 自由文入力をスキップ
 *   - reservation_visit_date / _time         … 日時候補 (Pkg1 と prefix を分ける)
 *   - reservation_visit_confirm&value=ok|change … 確定 / 日時変更
 *
 * 仕様: Phase 4 (リッチメニュー「各種予約」3 分岐 + 来店予定ゲート・2026-06-24 user 承認)。
 */
import type { StoreRow } from './trycle-repo.js';
import type { VisitDay } from './trycle-visit-slots.js';
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
import { formatVisitAt } from './trycle-pkg1-flex.js';

/** LINE メッセージ最小型 (Pkg1 の LineMessage と構造的に互換)。 */
export interface LineMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

export function textMessage(text: string): LineMessage {
  return { type: 'text', text };
}

/**
 * padding を効かせるため text を box でラップした本文行 (Pkg1 bodyText と同型)。
 * text コンポーネントに直接 padding を付けると LINE が 400 で reject するため box 経由。
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

// ── ① 各種予約 3 分岐 (リッチメニュー「各種予約」タップ) ───────────────────────

/**
 * ご予約内容を 3 択で選ばせる Flex。洗車系は STORES へ、メンテは Pkg1 へ、その他は
 * 来店予定ゲートへ分岐する。各行の補足は section ではなく行下のキャプションで添える。
 */
export function reservationMenuPrompt(): LineMessage {
  const contents: object[] = [
    buildSectionLabel('⭐ ご予約内容を選んでください'),
    buildTapRow({
      icon: '🚲',
      label: '洗車・ホイール試乗・フィッティング',
      data: 'action=reservation_stores',
    }),
    bodyText('STORES でご予約いただきます', { muted: true, size: 'xs' }),
    buildDivider(),
    buildTapRow({
      icon: '🔧',
      label: 'メンテナンスの予約',
      data: 'action=reservation_maintenance',
    }),
    bodyText('整備のお見積もり・ご予約', { muted: true, size: 'xs' }),
    buildDivider(),
    buildTapRow({
      icon: '💬',
      label: 'その他 (車体購入相談・初回相談など)',
      data: 'action=reservation_visit_start',
    }),
    bodyText('ご来店日時のご予約', { muted: true, size: 'xs' }),
  ];
  return buildListBubble({
    altText: 'ご予約内容を選んでください',
    headerTitle: '各種予約',
    headerSubtitle: 'ご予約内容をお選びください',
    contents,
  });
}

// ── ② 洗車・試乗・フィッティング → STORES リンク ──────────────────────────────

/**
 * STORES 予約ページへの URI リンク Bubble。storesUrl 未設定時は fail-loud で
 * スタッフ折り返しに倒す (URI ボタンを出さない・consentPrompt と同じ方針)。
 */
export function storesLinkPrompt(storesUrl: string | undefined): LineMessage {
  if (!storesUrl) {
    return buildListBubble({
      altText: 'STORES 予約 (準備中)',
      headerTitle: 'STORES でのご予約',
      headerSubtitle: '準備中です',
      contents: [
        bodyText('ただいまご予約ページの準備中です。スタッフよりご連絡いたします。', {
          muted: true,
        }),
      ],
    });
  }
  const uriRow = {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    paddingTop: 'md',
    paddingBottom: 'md',
    paddingStart: 'md',
    paddingEnd: 'md',
    action: { type: 'uri', label: 'STORES でご予約', uri: storesUrl },
    contents: [
      { type: 'text', text: '🗓', size: 'md', flex: 0 },
      {
        type: 'text',
        text: 'STORES でご予約はこちら',
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
    altText: 'STORES でのご予約',
    headerTitle: 'STORES でのご予約',
    headerSubtitle: '洗車・ホイール試乗・フィッティング',
    contents: [
      bodyText('洗車・ホイール試乗・フィッティングは STORES からご予約いただけます。', {
        muted: true,
      }),
      buildDivider(),
      uriRow,
    ],
  });
}

// ── ④ その他 → 来店予定ゲート ─────────────────────────────────────────────────

/**
 * 来店内容の自由文入力 prompt (任意・skip 可)。skip ボタンで内容未指定のまま日時へ進む。
 */
export function visitInquiryPrompt(): LineMessage {
  const contents: object[] = [
    bodyText('ご来店内容を簡単に教えてください（任意）。\n例：「ロードバイクの購入を相談したい」'),
    buildDivider(),
    buildTapRow({ icon: '⏭', label: '入力せずに進む', data: 'action=reservation_visit_skip' }),
  ];
  return buildListBubble({
    altText: 'ご来店内容を教えてください',
    headerTitle: 'ご来店のご相談',
    headerSubtitle: 'ご来店内容をお書きください（任意）',
    contents,
  });
}

/**
 * 来店予定の日付選択 (Pkg1 reservationDateList と同スタイル・postback prefix のみ別)。
 * 候補ゼロは fail-loud。
 */
export function visitDateList(store: StoreRow, days: ReadonlyArray<VisitDay>): LineMessage {
  if (days.length === 0) {
    return buildListBubble({
      altText: 'ご来店日の候補が見つかりません',
      headerTitle: `${store.name} - ご来店日`,
      headerSubtitle: '候補が見つかりませんでした',
      contents: [
        bodyText(
          'ただいまご案内できる来店日が見つかりませんでした。スタッフよりご連絡いたします。',
          { muted: true },
        ),
      ],
    });
  }
  const tapRows = days.map((day) =>
    buildTapRow({ icon: '📅', label: day.label, data: `action=reservation_visit_date&value=${day.date}` }),
  );
  return buildPaginatedListMessages({
    altText: 'ご来店日をお選びください',
    headerTitle: `${store.name} - ご来店日`,
    headerSubtitle: '来店予定日をお選びください',
    leadingContents: [buildSectionLabel('📅 ご来店日を選んでください')],
    tapRows,
  })[0]!;
}

/**
 * 来店予定の時間選択 (Pkg1 reservationTimeList と同スタイル・postback prefix のみ別)。
 * slots ゼロ (枠切れ) は fail-loud。
 */
export function visitTimeList(store: StoreRow, day: VisitDay): LineMessage {
  if (day.slots.length === 0) {
    return buildListBubble({
      altText: 'ご来店時間の候補が見つかりません',
      headerTitle: `${store.name} - ${day.label}`,
      headerSubtitle: '空き時間が見つかりませんでした',
      contents: [
        bodyText('この日のご案内できる時間が見つかりませんでした。別の日をお選びください。', {
          muted: true,
        }),
      ],
    });
  }
  const tapRows = day.slots.map((slot) =>
    buildTapRow({ icon: '🕒', label: slot.label, data: `action=reservation_visit_time&value=${slot.value}` }),
  );
  return buildPaginatedListMessages({
    altText: 'ご来店時間をお選びください',
    headerTitle: `${store.name} - ${day.label}`,
    headerSubtitle: 'ご来店時間をお選びください',
    leadingContents: [buildSectionLabel(`🕒 ${day.label} の時間を選んでください`)],
    tapRows,
  })[0]!;
}

// ── 店舗選択 (来店予定ゲート・複数店舗時のみ) ──────────────────────────────────

/**
 * 来店店舗の選択 (Pkg1 reservationStoreCarousel と同スタイル・postback prefix 別)。
 * 店舗が 1 件のみのときは呼び出し側で skip し、この Flex は出さない。
 */
export function visitStoreList(stores: ReadonlyArray<StoreRow>): LineMessage {
  const tapRows = stores.map((store) =>
    buildTapRow({
      icon: '🏪',
      label: store.name,
      data: `action=reservation_visit_store&value=${store.id}`,
    }),
  );
  return buildPaginatedListMessages({
    altText: 'ご来店店舗をお選びください',
    headerTitle: 'ご来店店舗',
    headerSubtitle: 'ご来店店舗をお選びください',
    leadingContents: [buildSectionLabel('🏪 店舗を選んでください')],
    tapRows,
  })[0]!;
}

// ── 来店予定ゲート 確認 (予約する / 日時を変更する) ────────────────────────────

/**
 * 確認 Flex。日時 + ご相談内容を提示し「予約する」「日時を変更する」の 2 択。
 * inquiry 未指定時は「内容未指定」と明示する (架空の内容を作らない)。
 */
export function visitConfirmPrompt(
  storeName: string,
  visitAtIso: string,
  inquiry: string | null,
): LineMessage {
  const human = formatVisitAt(visitAtIso);
  const inquiryText = inquiry && inquiry.trim() !== '' ? inquiry.trim() : '内容未指定';
  const contents: object[] = [
    bodyText('以下の内容でご来店予約を承ります。'),
    buildDivider(),
    bodyText(`▼ 店舗: ${storeName}`),
    bodyText(`▼ 日時: ${human}`),
    bodyText(`▼ ご相談内容: ${inquiryText}`),
    buildDivider(),
    buildTapRow({ icon: '✅', label: '予約する', data: 'action=reservation_visit_confirm&value=ok' }),
    buildDivider(),
    buildTapRow({
      icon: '🔄',
      label: '日時を変更する',
      data: 'action=reservation_visit_confirm&value=change',
    }),
  ];
  return buildListBubble({
    altText: 'ご来店予約の確認',
    headerTitle: 'ご確認',
    headerSubtitle: 'ご来店予約の内容をご確認ください',
    contents,
  });
}

export type { FlexMessage };
