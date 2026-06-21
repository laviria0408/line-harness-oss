/**
 * TRYCLE 共通 Flex helper (LH 準拠スタイルの正本)。
 *
 * Pkg8 FAQ で確立した「1 Bubble・縦リスト型」スタイル (tap row + divider +
 * section label) を Pkg1 / Pkg8 双方から使えるよう切り出したもの。LINE の
 * Buttons / Carousel Template は横スライダー/狭幅で UX が劣るため使わず、
 * Flex Bubble の縦リストで統一する (user 指摘「縦並びにして」「LH 準拠」)。
 *
 * - buildTapRow   : 水平 box・アイコン + ラベル + `›`・postback action 付きの 1 行
 * - buildSectionLabel : sm + bold + muted のセクション見出し
 * - buildDivider  : separator (DIVIDER_COLOR)
 * - 色定数 / spacing は Pkg8 v3 と完全一致
 */

/**
 * Flex メッセージの最小型 (LineClient へ渡す配列要素)。
 * index signature を持たせ、Pkg1 の LineMessage ({ type; [k: string]: unknown })
 * とも構造的に互換にする (Flex は valid な LINE message なので安全)。
 */
export interface FlexMessage {
  readonly type: 'flex';
  readonly altText: string;
  readonly contents: object;
  readonly [key: string]: unknown;
}

// ── 色定数 (Pkg8 v3 と一致) ───────────────────────────────────────────────────

export const TRYCLE_GREEN = '#06C755';
export const TEXT_PRIMARY = '#1e293b';
export const TEXT_MUTED = '#64748b';
export const DIVIDER_COLOR = '#e2e8f0';

// ── tap row / section label / divider ─────────────────────────────────────────

export interface TapRow {
  /** 行頭アイコン (絵文字 or `▸` 等)。 */
  readonly icon: string;
  readonly label: string;
  /** postback の data 文字列。 */
  readonly data: string;
}

/**
 * 1 行ぶんのタップ可能な行 (水平 box)。アイコン + ラベル + 右端の `›`。
 * 行全体に postback action を付けて、どこをタップしても遷移する。
 */
export function buildTapRow(row: TapRow): object {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    paddingTop: 'md',
    paddingBottom: 'md',
    paddingStart: 'md',
    paddingEnd: 'md',
    action: { type: 'postback', label: row.label, data: row.data },
    contents: [
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
    ],
  };
}

/** セクション見出し (sm + bold + muted)。 */
export function buildSectionLabel(text: string): object {
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

/** 区切り線 (separator)。 */
export function buildDivider(): object {
  return { type: 'separator', color: DIVIDER_COLOR };
}

// ── 1 Bubble・縦リスト Bubble の組み立て ──────────────────────────────────────

export interface ListBubbleArgs {
  readonly altText: string;
  readonly headerTitle: string;
  readonly headerSubtitle?: string;
  /** body 縦リストの中身 (section label / tap row / divider を並べたもの)。 */
  readonly contents: ReadonlyArray<object>;
  readonly size?: 'mega' | 'giga';
}

/**
 * 緑ヘッダー + 縦リスト body の 1 Bubble を組み立てる (Pkg8 buildEntryBubble と同型)。
 * 選択肢系 (region / symptom / variant / qty / cart / confirm) で共通利用する。
 */
export function buildListBubble(args: ListBubbleArgs): FlexMessage {
  const headerContents: object[] = [
    {
      type: 'text',
      text: args.headerTitle,
      size: 'lg',
      weight: 'bold',
      color: '#ffffff',
      wrap: true,
    },
  ];
  if (args.headerSubtitle) {
    headerContents.push({
      type: 'text',
      text: args.headerSubtitle,
      size: 'sm',
      color: '#ffffff',
      margin: 'xs',
      wrap: true,
    });
  }
  return {
    type: 'flex',
    altText: args.altText,
    contents: {
      type: 'bubble',
      size: args.size ?? 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        backgroundColor: TRYCLE_GREEN,
        contents: headerContents,
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'none',
        paddingAll: 'none',
        contents: [...args.contents],
      },
    },
  };
}
