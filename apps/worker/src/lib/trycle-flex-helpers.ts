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

// ── byte 予算 carousel 分割 (LINE 1 bubble = 10KB 上限の回避) ──────────────────
//
// LINE の Flex 制限: 1 bubble の JSON は最大 10240 byte・1 carousel は最大 12 bubble。
// tap-row が多い選択肢 (その他関係 15 件等) は単一 bubble が 10KB に迫り、reply が
// 400 で silent reject される (safeReply が握り潰す → 利用者には「無反応」)。920ecff で
// 旧 category モデルに入れた byte 予算分割を、本物 region/symptom/variant モデルに port。
// row を byte 予算で chunk し、複数になるときだけ carousel で返す (単一なら従来どおり 1 bubble)。

/**
 * 1 bubble の安全 byte 予算。LINE 上限 10240 から header / section label / divider・
 * altText・carousel ラッパ・byte 計測誤差の余裕を引いた値。
 */
export const BUBBLE_BYTE_BUDGET = 8500;
/** header + section label + 末尾要素など、tap-row 以外で 1 bubble が使う固定 overhead の見積り。 */
const BUBBLE_FIXED_OVERHEAD = 1200;
/** LINE carousel の bubble 上限。 */
const CAROUSEL_MAX_BUBBLES = 12;

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

const DIVIDER_BYTES = byteLength(buildDivider());

/**
 * tap-row 群を byte 予算で複数ページに割る。各 row は単体では予算内である前提
 * (1 row ≒ 300-450 byte なので必ず収まる)。1 ページに最低 1 row は載せる。
 */
function paginateRows(rows: ReadonlyArray<object>): object[][] {
  const pages: object[][] = [];
  let current: object[] = [];
  let currentBytes = BUBBLE_FIXED_OVERHEAD;
  for (const row of rows) {
    const rowBytes = byteLength(row) + DIVIDER_BYTES;
    if (current.length > 0 && currentBytes + rowBytes > BUBBLE_BYTE_BUDGET) {
      pages.push(current);
      current = [];
      currentBytes = BUBBLE_FIXED_OVERHEAD;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length > 0) pages.push(current);
  // carousel 上限を超える場合は末尾を 1 bubble に畳む (極端な件数の保険)。
  if (pages.length > CAROUSEL_MAX_BUBBLES) {
    const head = pages.slice(0, CAROUSEL_MAX_BUBBLES - 1);
    const tail = pages.slice(CAROUSEL_MAX_BUBBLES - 1).flat();
    return [...head, tail];
  }
  return pages;
}

export interface PaginatedListArgs {
  readonly altText: string;
  readonly headerTitle: string;
  readonly headerSubtitle?: string;
  /** tap-row の上に常に置く要素 (section label 等)。各ページ先頭に複製される。 */
  readonly leadingContents?: ReadonlyArray<object>;
  /** 本体の tap-row (各 row は buildTapRow の戻り値)。divider は本 helper が挿入する。 */
  readonly tapRows: ReadonlyArray<object>;
  /** tap-row の後に常に置く要素 (注記・戻る row 等)。最終ページのみ付与。 */
  readonly trailingContents?: ReadonlyArray<object>;
  /** 各 tap-row の間に divider を挿入するか (既定 true)。 */
  readonly dividers?: boolean;
  /** ページ数が複数のときの header subtitle 上書き (既定 "n / total ページ")。 */
  readonly pageSubtitle?: (page: number, total: number) => string;
}

/**
 * 「leading + tap-row 群 + trailing」を、10KB を超えないよう必要なら carousel に分割した
 * LineMessage[] を返す。単一ページなら従来どおり 1 bubble (見た目不変)。複数ページなら
 * 各 row 内容で byte を測って詰め、carousel で返す。tap-row 系の選択肢 builder で共通利用する。
 */
export function buildPaginatedListMessages(args: PaginatedListArgs): FlexMessage[] {
  const useDividers = args.dividers ?? true;
  const leading = args.leadingContents ?? [];
  const trailing = args.trailingContents ?? [];
  const pages = paginateRows(args.tapRows);

  /** 1 ページ分の body 要素 (leading + row/divider 群 + trailing) を組む。 */
  const pageContents = (pageRows: ReadonlyArray<object>, withTrailing: boolean): object[] => {
    const contents: object[] = [...leading];
    pageRows.forEach((row, i) => {
      contents.push(row);
      if (useDividers && i < pageRows.length - 1) contents.push(buildDivider());
    });
    if (withTrailing) {
      if (useDividers && pageRows.length > 0 && trailing.length > 0) contents.push(buildDivider());
      contents.push(...trailing);
    }
    return contents;
  };

  // 単一ページ: 従来どおり 1 bubble。
  if (pages.length <= 1) {
    return [
      buildListBubble({
        altText: args.altText,
        headerTitle: args.headerTitle,
        headerSubtitle: args.headerSubtitle,
        contents: pageContents(pages[0] ?? [], true),
      }),
    ];
  }

  // 複数ページ: carousel。末尾ページのみ trailing を付ける。
  const bubbles: object[] = pages.map((pageRows, idx) => {
    const single = buildListBubble({
      altText: args.altText,
      headerTitle: args.headerTitle,
      headerSubtitle: args.pageSubtitle
        ? args.pageSubtitle(idx + 1, pages.length)
        : `${idx + 1} / ${pages.length} ページ`,
      contents: pageContents(pageRows, idx === pages.length - 1),
    });
    // buildListBubble は { type:'flex', contents:{type:'bubble',...} }。carousel には bubble 本体だけ入れる。
    return single.contents;
  });

  return [
    {
      type: 'flex',
      altText: args.altText,
      contents: { type: 'carousel', contents: bubbles },
    },
  ];
}
