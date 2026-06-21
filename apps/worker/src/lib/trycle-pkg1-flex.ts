/**
 * TRYCLE Pkg1 (整備見積) Flex Bubble builders.
 *
 * Pkg8 (trycle-pkg8.ts) の縦リスト Bubble パターンを流用し、経路 A〜D の各画面を
 * 純関数で組む (LineClient 不要 = テスト容易)。色・余白は Pkg8 と揃える。
 *
 * 設計: Pkg1 詳細設計 v1.1.1 §3 (page 386050ad6a7e81f8b701cd52c9201af6)。
 */
import { formatYen, type Quote } from './quote.js';
import type { CartItem } from './trycle-session.js';
import type { Pkg1LaborEntry } from './trycle-pkg1-repo.js';
import type { LaborOption } from './trycle-repo.js';
import type { VisitDay } from './trycle-visit-slots.js';

const TRYCLE_GREEN = '#06C755';
const TEXT_PRIMARY = '#1e293b';
const TEXT_MUTED = '#64748b';
const ACCENT = '#0f766e';
const DIVIDER_COLOR = '#e2e8f0';

export interface FlexMessage {
  readonly type: 'flex';
  readonly altText: string;
  readonly contents: object;
}

/**
 * カテゴリ表示名 (DB は英語 code・UI は日本語)。未知 code は raw を返す。
 * canonical な日本語名は将来 labor_categories マスタ化候補 (現状はここで吸収)。
 */
const CATEGORY_LABELS: Record<string, string> = {
  brake: 'ブレーキ',
  shift: '変速・シフト',
  drivetrain: '駆動系 (チェーン/スプロケット)',
  tire: 'タイヤ・チューブ',
  wheel: 'ホイール・振れ取り',
  hub: 'ハブ・ベアリング',
  bottom: 'BB・クランク',
  'bottom-bracket': 'BB・クランク',
  headset: 'ヘッドセット',
  frame: 'フレーム・フォーク',
  cable: 'ケーブル・ワイヤー',
  build: '組立・コンポーネント',
  assembly: '組立・コンポーネント',
  overhaul: 'オーバーホール',
  cleaning: '洗車・クリーニング',
  general: 'その他・点検',
  other: 'その他',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

// ── 共通パーツ ────────────────────────────────────────────────────────────────

interface TapRow {
  icon: string;
  label: string;
  data: string;
  sub?: string;
}

function buildTapRow(row: TapRow): object {
  const main: object[] = [
    { type: 'text', text: row.icon, size: 'md', flex: 0 },
    {
      type: 'text',
      text: row.label,
      size: 'md',
      color: TEXT_PRIMARY,
      wrap: true,
      flex: 1,
      weight: 'regular',
    },
    { type: 'text', text: '›', size: 'lg', color: TEXT_MUTED, flex: 0, align: 'end' },
  ];
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    paddingTop: 'md',
    paddingBottom: 'md',
    paddingStart: 'md',
    paddingEnd: 'md',
    action: { type: 'postback', label: clampLabel(row.label), data: row.data },
    contents: row.sub
      ? [
          {
            type: 'box',
            layout: 'vertical',
            flex: 1,
            spacing: 'xs',
            contents: [
              { type: 'text', text: row.label, size: 'md', color: TEXT_PRIMARY, wrap: true },
              { type: 'text', text: row.sub, size: 'xs', color: TEXT_MUTED, wrap: true },
            ],
          },
          { type: 'text', text: '›', size: 'lg', color: TEXT_MUTED, flex: 0, align: 'end' },
        ]
      : main,
  };
}

function buildSectionLabel(text: string): object {
  return {
    type: 'box',
    layout: 'vertical',
    paddingTop: 'md',
    paddingBottom: 'sm',
    paddingStart: 'md',
    paddingEnd: 'md',
    contents: [{ type: 'text', text, size: 'sm', color: TEXT_MUTED, weight: 'bold' }],
  };
}

function buildDivider(): object {
  return { type: 'separator', color: DIVIDER_COLOR };
}

function header(title: string, subtitle?: string): object {
  const contents: object[] = [
    { type: 'text', text: title, size: 'lg', weight: 'bold', color: '#ffffff', wrap: true },
  ];
  if (subtitle) {
    contents.push({ type: 'text', text: subtitle, size: 'sm', color: '#ffffff', margin: 'xs', wrap: true });
  }
  return {
    type: 'box',
    layout: 'vertical',
    paddingAll: 'lg',
    backgroundColor: TRYCLE_GREEN,
    contents,
  };
}

/** LINE postback label は 20 文字上限。超過は切り詰める。 */
function clampLabel(label: string): string {
  return label.length > 20 ? label.slice(0, 19) + '…' : label;
}

// ── 経路 A: 入口 3 択 (REQ-PKG1-002) ─────────────────────────────────────────
//
// 状況ふりわけ 3 択。本物 (trycle-line-harness pkg1-messages.ts / pkg1-estimate.ts)
// の DISPATCH_LABELS と分岐に忠実:
//   identified    原因特定済み      → 正規見積ルート (経路 B カテゴリ選択へ)
//   comprehensive 包括メンテしたい  → 現物確認が必要なためスタッフ相談誘導 (経路 B に進めない)
//   unknown       原因がわからない  → 同上スタッフ相談誘導
// postback value は本物の `pkg1_dispatch&value=<key>` を OSS の prefix 規約に合わせ
// `pkg1_dispatch_<key>` で表現する (UI の見た目・タップ行構造は維持)。

export type Pkg1Dispatch = 'identified' | 'comprehensive' | 'unknown';

/** 状況ふりわけ 3 択のラベル (本物 DISPATCH_LABELS と一致・文言厳守)。 */
export const DISPATCH_LABELS: Readonly<Record<Pkg1Dispatch, string>> = {
  identified: '原因特定済み',
  comprehensive: '包括メンテしたい',
  unknown: '原因がわからない',
};

export function buildEntryBubble(): FlexMessage {
  const contents: object[] = [
    buildSectionLabel('まず、いまの状況に近いものをお選びください'),
    buildTapRow({
      icon: '🛠',
      label: DISPATCH_LABELS.identified,
      sub: '交換・調整したい箇所がもう分かっている',
      data: 'pkg1_dispatch_identified',
    }),
    buildDivider(),
    buildTapRow({
      icon: '🔧',
      label: DISPATCH_LABELS.comprehensive,
      sub: '全体をまとめて点検・整備してほしい',
      data: 'pkg1_dispatch_comprehensive',
    }),
    buildDivider(),
    buildTapRow({
      icon: '🔍',
      label: DISPATCH_LABELS.unknown,
      sub: '不調だけど原因が分からない・点検してほしい',
      data: 'pkg1_dispatch_unknown',
    }),
  ];
  return {
    type: 'flex',
    altText: '整備のご相談・状況をお選びください',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: header('整備見積もり', '状況を下から選んでね'),
      body: { type: 'box', layout: 'vertical', spacing: 'none', paddingAll: 'none', contents },
    },
  };
}

// ── 経路 B: カテゴリ選択 (REQ-PKG1-004) ──────────────────────────────────────

export function buildCategoryBubble(categories: ReadonlyArray<string>): FlexMessage {
  const contents: object[] = [buildSectionLabel('整備カテゴリ')];
  for (const cat of categories) {
    contents.push(buildTapRow({ icon: '▸', label: categoryLabel(cat), data: `pkg1_cat_${cat}` }));
    contents.push(buildDivider());
  }
  contents.push(buildTapRow({ icon: '💬', label: '一覧にない / スタッフに相談', data: 'pkg1_staff_consult' }));
  return {
    type: 'flex',
    altText: '整備カテゴリを選択',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: header('整備カテゴリ', '見積もりたい箇所を選んでね'),
      body: { type: 'box', layout: 'vertical', spacing: 'none', paddingAll: 'none', contents },
    },
  };
}

// ── 経路 B: メニュー (labor) 選択 (REQ-PKG1-005/006) ──────────────────────────

export function buildLaborListBubble(
  category: string,
  labors: ReadonlyArray<Pkg1LaborEntry>,
): FlexMessage {
  const contents: object[] = [buildSectionLabel(categoryLabel(category))];
  for (const labor of labors) {
    contents.push(
      buildTapRow({
        icon: '▸',
        label: labor.name,
        sub: priceLabel(labor),
        data: `pkg1_labor_${labor.id}`,
      }),
    );
    contents.push(buildDivider());
  }
  contents.push(buildTapRow({ icon: '←', label: 'カテゴリへ戻る', data: 'pkg1_categories' }));
  return {
    type: 'flex',
    altText: `${categoryLabel(category)} のメニュー`,
    contents: {
      type: 'bubble',
      size: 'giga',
      header: header(categoryLabel(category), `${labors.length} 件のメニュー`),
      body: { type: 'box', layout: 'vertical', spacing: 'none', paddingAll: 'none', contents },
    },
  };
}

/** 工賃の価格表示文字列 (range / open-ended に対応)。 */
export function priceLabel(labor: Pkg1LaborEntry): string {
  if (labor.price_open_ended) {
    return `${formatYen(labor.price)}〜`;
  }
  if (labor.price_max != null && labor.price_max !== labor.price) {
    return `${formatYen(labor.price)}〜${formatYen(labor.price_max)}`;
  }
  return formatYen(labor.price);
}

// ── 経路 B: variant (labor_options) 選択 (REQ-PKG1-005) ───────────────────────

export function buildVariantBubble(
  labor: Pkg1LaborEntry,
  options: ReadonlyArray<LaborOption>,
): FlexMessage {
  const contents: object[] = [
    buildSectionLabel('追加オプション (任意・複数選択可)'),
  ];
  for (const opt of options) {
    contents.push(
      buildTapRow({
        icon: '＋',
        label: opt.name,
        sub: `+${formatYen(opt.price)}`,
        data: `pkg1_opt_${labor.id}_${opt.id}`,
      }),
    );
    contents.push(buildDivider());
  }
  contents.push(
    buildTapRow({ icon: '🛒', label: 'オプションなしでカートに追加', data: `pkg1_add_${labor.id}` }),
  );
  return {
    type: 'flex',
    altText: `${labor.name} のオプション`,
    contents: {
      type: 'bubble',
      size: 'giga',
      header: header(labor.name, priceLabel(labor)),
      body: { type: 'box', layout: 'vertical', spacing: 'none', paddingAll: 'none', contents },
    },
  };
}

// ── 経路 B: カート確認 (REQ-PKG1-008/021) ────────────────────────────────────

export function buildCartBubble(cart: ReadonlyArray<CartItem>): FlexMessage {
  const itemBoxes: object[] = [];
  let subtotal = 0;
  for (const item of cart) {
    const lineTotal = (item.unit_price + item.option_total) * item.qty;
    subtotal += lineTotal;
    const sub = item.option_names.length > 0 ? `+ ${item.option_names.join(' / ')}` : undefined;
    const rowContents: object[] = [
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        spacing: 'xs',
        contents: [
          {
            type: 'text',
            text: item.qty > 1 ? `${item.name} ×${item.qty}` : item.name,
            size: 'sm',
            color: TEXT_PRIMARY,
            wrap: true,
          },
          ...(sub ? [{ type: 'text', text: sub, size: 'xs', color: TEXT_MUTED, wrap: true }] : []),
        ],
      },
      { type: 'text', text: formatYen(lineTotal), size: 'sm', color: TEXT_PRIMARY, align: 'end', flex: 0 },
    ];
    itemBoxes.push({
      type: 'box',
      layout: 'horizontal',
      paddingAll: 'md',
      spacing: 'sm',
      contents: rowContents,
    });
    itemBoxes.push(buildDivider());
  }

  return {
    type: 'flex',
    altText: 'カートの内容',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: header('カート', `${cart.length} 品目`),
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'none',
        paddingAll: 'none',
        contents: [
          ...itemBoxes,
          {
            type: 'box',
            layout: 'horizontal',
            paddingAll: 'md',
            contents: [
              { type: 'text', text: '小計 (税抜)', size: 'sm', color: TEXT_MUTED, flex: 1 },
              { type: 'text', text: formatYen(subtotal), size: 'sm', weight: 'bold', color: TEXT_PRIMARY, align: 'end' },
            ],
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
            style: 'secondary',
            height: 'sm',
            action: { type: 'postback', label: '＋ 他の整備を追加', data: 'pkg1_categories' },
          },
          {
            type: 'button',
            style: 'primary',
            color: TRYCLE_GREEN,
            height: 'sm',
            action: { type: 'postback', label: '見積もりを確認', data: 'pkg1_confirm' },
          },
        ],
      },
    },
  };
}

// ── 経路 C: 見積 Bubble (REQ-PKG1-009/010/011) ───────────────────────────────

export function buildEstimateBubble(
  quote: Quote,
  partsNotice: string,
): FlexMessage {
  const itemRows: object[] = [];
  for (const li of quote.lineItems) {
    const priceStr =
      li.amountMax != null && li.amountMax !== li.amount
        ? `${formatYen(li.amount)}〜${formatYen(li.amountMax)}`
        : formatYen(li.amount);
    itemRows.push({
      type: 'box',
      layout: 'horizontal',
      paddingAll: 'sm',
      spacing: 'sm',
      contents: [
        {
          type: 'text',
          text: li.qty > 1 ? `${li.name} ×${li.qty}` : li.name,
          size: 'sm',
          color: TEXT_PRIMARY,
          wrap: true,
          flex: 1,
        },
        { type: 'text', text: priceStr, size: 'sm', color: TEXT_PRIMARY, align: 'end', flex: 0 },
      ],
    });
  }

  const totalStr =
    quote.totalMax !== quote.total
      ? `${formatYen(quote.total)}〜${formatYen(quote.totalMax)}`
      : formatYen(quote.total);
  const subtotalStr =
    quote.subtotalMax !== quote.subtotal
      ? `${formatYen(quote.subtotal)}〜${formatYen(quote.subtotalMax)}`
      : formatYen(quote.subtotal);

  return {
    type: 'flex',
    altText: 'お見積もり (概算)',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        backgroundColor: ACCENT,
        contents: [
          { type: 'text', text: '【 概算 】お見積もり', size: 'xl', weight: 'bold', color: '#ffffff' },
          {
            type: 'text',
            text: '正式なお見積もりは現車確認後にご案内します',
            size: 'xs',
            color: '#ffffff',
            margin: 'sm',
            wrap: true,
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'none',
        paddingAll: 'none',
        contents: [
          ...itemRows,
          buildDivider(),
          summaryRow('小計', subtotalStr, false),
          summaryRow(`消費税 (10%)`, formatYen(quote.tax), false),
          summaryRow('合計 (税込)', totalStr, true),
          buildDivider(),
          {
            type: 'box',
            layout: 'vertical',
            paddingAll: 'md',
            spacing: 'sm',
            contents: [
              { type: 'text', text: '※ 状況により変動する場合があります', size: 'xs', color: TEXT_MUTED, wrap: true },
              { type: 'text', text: partsNotice, size: 'xs', color: TEXT_MUTED, wrap: true },
            ],
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
            action: { type: 'postback', label: 'ご来店予定を伝える', data: 'pkg1_visit_start' },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: { type: 'postback', label: 'スタッフに相談する', data: 'pkg1_staff_estimate' },
          },
        ],
      },
    },
  };
}

function summaryRow(label: string, value: string, emphasize: boolean): object {
  return {
    type: 'box',
    layout: 'horizontal',
    paddingTop: 'sm',
    paddingBottom: 'sm',
    paddingStart: 'md',
    paddingEnd: 'md',
    contents: [
      {
        type: 'text',
        text: label,
        size: emphasize ? 'md' : 'sm',
        color: emphasize ? TEXT_PRIMARY : TEXT_MUTED,
        weight: emphasize ? 'bold' : 'regular',
        flex: 1,
      },
      {
        type: 'text',
        text: value,
        size: emphasize ? 'lg' : 'sm',
        color: emphasize ? ACCENT : TEXT_PRIMARY,
        weight: emphasize ? 'bold' : 'regular',
        align: 'end',
      },
    ],
  };
}

// ── 経路 D: 同意書ゲート (REQ-PKG1-016) ───────────────────────────────────────

export function buildConsentPromptBubble(liffUrl: string): FlexMessage {
  return {
    type: 'flex',
    altText: '整備同意書のご確認',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: header('整備同意書', 'ご来店前にご確認ください'),
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: '整備のご依頼にあたり、作業内容・料金・個人情報の取り扱いについて同意書のご確認をお願いします。',
            size: 'sm',
            color: TEXT_PRIMARY,
            wrap: true,
          },
          {
            type: 'text',
            text: '※ 同意は 1 年間有効です。',
            size: 'xs',
            color: TEXT_MUTED,
            wrap: true,
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: TRYCLE_GREEN,
            height: 'sm',
            action: { type: 'uri', label: '同意書を確認する', uri: liffUrl },
          },
        ],
      },
    },
  };
}

// ── 経路 D: 来店予定日選択 / 時刻選択 (REQ-PKG1-023) ──────────────────────────

export function buildVisitDayBubble(days: ReadonlyArray<VisitDay>): FlexMessage {
  const contents: object[] = [buildSectionLabel('ご来店予定日 (来店順対応・予約ではありません)')];
  for (const day of days) {
    contents.push(buildTapRow({ icon: '📅', label: day.label, data: `pkg1_visit_day_${day.date}` }));
    contents.push(buildDivider());
  }
  return {
    type: 'flex',
    altText: 'ご来店予定日を選択',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: header('ご来店予定', '来店予定日を選んでね'),
      body: { type: 'box', layout: 'vertical', spacing: 'none', paddingAll: 'none', contents },
    },
  };
}

export function buildVisitTimeBubble(day: VisitDay): FlexMessage {
  const rows: object[] = [];
  // 時刻ボタンは 2 列グリッドで配置する。
  for (let i = 0; i < day.slots.length; i += 2) {
    const pair = day.slots.slice(i, i + 2);
    rows.push({
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      paddingStart: 'md',
      paddingEnd: 'md',
      paddingTop: 'sm',
      paddingBottom: 'sm',
      contents: pair.map((slot) => ({
        type: 'button',
        style: 'secondary',
        height: 'sm',
        flex: 1,
        action: { type: 'postback', label: slot.label, data: `pkg1_visit_at_${slot.value}` },
      })),
    });
  }
  return {
    type: 'flex',
    altText: `${day.label} の来店時刻を選択`,
    contents: {
      type: 'bubble',
      size: 'giga',
      header: header(`${day.label} の来店時刻`, '時刻を選んでね'),
      body: { type: 'box', layout: 'vertical', spacing: 'none', paddingAll: 'none', contents: rows },
    },
  };
}

// ── 汎用 ack / 案内 Bubble ────────────────────────────────────────────────────

export function buildAckBubble(
  title: string,
  body: string,
  buttons: ReadonlyArray<{ label: string; data?: string; uri?: string; style: 'primary' | 'secondary' }>,
): FlexMessage {
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: title, weight: 'bold', size: 'md', color: TEXT_PRIMARY, wrap: true },
          { type: 'text', text: body, size: 'sm', color: TEXT_MUTED, wrap: true, margin: 'sm' },
        ],
      },
      footer:
        buttons.length > 0
          ? {
              type: 'box',
              layout: 'vertical',
              spacing: 'sm',
              paddingAll: 'lg',
              contents: buttons.map((b) => ({
                type: 'button',
                style: b.style,
                color: b.style === 'primary' ? TRYCLE_GREEN : undefined,
                height: 'sm',
                action: b.uri
                  ? { type: 'uri', label: b.label, uri: b.uri }
                  : { type: 'postback', label: b.label, data: b.data ?? 'pkg1_start' },
              })),
            }
          : undefined,
    },
  };
}
