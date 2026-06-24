/**
 * TRYCLE 包括メンテ (A2・Phase 4 v1.6) の Flex builders (状態を持たない純関数)。
 *
 *   overhaulMenuCarousel : 4 メニュー横スワイプ carousel (名前/料金/納期/詳細説明)
 *   overhaulMenuPicker   : 「メニューの選択に進む」後の 4 択 縦リスト
 *   overhaulEntryPrompt  : 初期メッセージ + [メニューの選択に進む][違いについて知る]
 *   overhaulMatrixMessages: 違いマトリクス (案 B per-menu cards + 案 A text 補足 in altText)
 *
 * アクセント色は TRYCLE オレンジ #f97316 (包括メンテ専用・通常 region の緑と差別化)。
 * 表示は Pkg8/Pkg1 で確立した buildListBubble / buildTapRow / buildPaginatedListMessages
 * に乗せつつ、carousel のメニュー bubble だけ専用にオレンジヘッダで組む。
 *
 * postback 命名:
 *   - action=pkg1_overhaul&value=picker  (メニューの選択に進む)
 *   - action=pkg1_overhaul&value=matrix  (違いについて知る)
 *   - action=pkg1_overhaul_menu&value={laborId}  (メニュー確定)
 *
 * 設計: Pkg1 v1.6 (page 386050ad6a7e81f8b701cd52c9201af6)。
 */
import type { OverhaulMenu, OverhaulMenuMatrix } from './trycle-overhaul-repo.js';
import {
  buildTapRow,
  buildSectionLabel,
  buildDivider,
  buildListBubble,
  type FlexMessage,
} from './trycle-flex-helpers.js';
import type { LineMessage } from './trycle-pkg1-flex.js';

/** TRYCLE オレンジ (包括メンテのアクセント色)。 */
export const TRYCLE_ORANGE = '#f97316';
const TEXT_PRIMARY = '#1e293b';
const TEXT_MUTED = '#64748b';
const DIVIDER_COLOR = '#e2e8f0';

// ── 料金 / 納期 表記 ───────────────────────────────────────────────────────────

/** メニュー料金の表示文言。open-ended → "¥X〜" / range → "¥X〜¥Y" / 固定 → "¥X"。 */
export function formatMenuPrice(menu: Pick<OverhaulMenu, 'price' | 'priceMax' | 'priceOpenEnded'>): string {
  const min = `¥${menu.price.toLocaleString('ja-JP')}`;
  if (menu.priceOpenEnded) return `${min}〜`;
  if (menu.priceMax !== null && menu.priceMax !== menu.price) {
    return `${min}〜¥${menu.priceMax.toLocaleString('ja-JP')}`;
  }
  return min;
}

/** 納期の表示文言。0-0 → "当日" / min===max → "N日" / range → "N〜M日" / 不明 → "店頭でご案内"。 */
export function formatMenuDuration(menu: Pick<OverhaulMenu, 'durationDaysMin' | 'durationDaysMax'>): string {
  const { durationDaysMin: min, durationDaysMax: max } = menu;
  if (min === null && max === null) return '店頭でご案内';
  if (min === 0 && max === 0) return '当日';
  if (min !== null && max !== null) {
    return min === max ? `${min}日` : `${min}〜${max}日`;
  }
  const only = min ?? max;
  return only === 0 ? '当日' : `${only}日`;
}

// ── 4 メニュー carousel (初期提示) ─────────────────────────────────────────────

function menuInfoRow(label: string, value: string, opts?: { bold?: boolean }): object {
  return {
    type: 'box',
    layout: 'horizontal',
    paddingStart: 'md',
    paddingEnd: 'md',
    paddingTop: 'xs',
    paddingBottom: 'xs',
    contents: [
      { type: 'text', text: label, size: 'sm', color: TEXT_MUTED, flex: 2, wrap: true },
      {
        type: 'text',
        text: value,
        size: 'sm',
        color: opts?.bold ? TRYCLE_ORANGE : TEXT_PRIMARY,
        weight: opts?.bold ? 'bold' : 'regular',
        align: 'end',
        flex: 3,
        wrap: true,
      },
    ],
  };
}

function menuBodyText(text: string): object {
  return {
    type: 'box',
    layout: 'vertical',
    paddingStart: 'md',
    paddingEnd: 'md',
    paddingTop: 'sm',
    paddingBottom: 'sm',
    contents: [{ type: 'text', text, size: 'sm', color: TEXT_PRIMARY, wrap: true }],
  };
}

/** 1 メニューの carousel bubble (オレンジヘッダ + 料金/納期 + 詳細 + 選択ボタン)。 */
function overhaulMenuBubble(menu: OverhaulMenu): object {
  const body: object[] = [
    menuInfoRow('料金', formatMenuPrice(menu), { bold: true }),
    menuInfoRow('納期', formatMenuDuration(menu)),
    buildDivider(),
  ];
  if (menu.detailedDescription) {
    body.push(menuBodyText(menu.detailedDescription));
    body.push(buildDivider());
  }
  body.push(
    buildTapRow({ icon: '✅', label: 'このメニューにする', data: `action=pkg1_overhaul_menu&value=${menu.laborId}` }),
  );

  const bubble: Record<string, unknown> = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      paddingAll: 'lg',
      backgroundColor: TRYCLE_ORANGE,
      contents: [{ type: 'text', text: menu.name, size: 'lg', weight: 'bold', color: '#ffffff', wrap: true }],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'none',
      paddingAll: 'none',
      contents: body,
    },
  };
  if (menu.heroImageUrl) {
    bubble.hero = {
      type: 'image',
      url: menu.heroImageUrl,
      size: 'full',
      aspectRatio: '20:13',
      aspectMode: 'cover',
    };
  }
  return bubble;
}

/** 4 メニューを横スワイプ carousel で出す (LINE carousel 上限 12・4 件なので余裕)。 */
export function overhaulMenuCarousel(menus: ReadonlyArray<OverhaulMenu>): FlexMessage {
  return {
    type: 'flex',
    altText: 'オーバーホール / 包括メンテのメニュー一覧',
    contents: { type: 'carousel', contents: menus.map(overhaulMenuBubble) },
  };
}

// ── 初期メッセージ (carousel の後の操作 2 択) ──────────────────────────────────

export function overhaulEntryActions(): FlexMessage {
  return buildListBubble({
    altText: 'メニューの選択に進む / オーバーホールの違いについて知る',
    headerTitle: '包括メンテ（オーバーホール）',
    headerSubtitle: '次の操作をお選びください',
    contents: [
      buildSectionLabel('次の操作を選んでください'),
      buildTapRow({ icon: '🛠', label: 'メニューの選択に進む', data: 'action=pkg1_overhaul&value=picker' }),
      buildDivider(),
      buildTapRow({ icon: 'ℹ️', label: 'オーバーホールの違いについて知る', data: 'action=pkg1_overhaul&value=matrix' }),
    ],
  });
}

/** 初期メッセージ文言 (carousel の前置き)。 */
export const OVERHAUL_LEAD_TEXT =
  'TRYCLE では全体的な車体のメンテナンスとして以下のメニューをご用意しています。';

// ── 「メニューの選択に進む」後の 4 択 縦リスト ─────────────────────────────────

export function overhaulMenuPicker(menus: ReadonlyArray<OverhaulMenu>): FlexMessage {
  const contents: object[] = [buildSectionLabel('🛠 メニューをお選びください')];
  menus.forEach((menu, i) => {
    contents.push(
      buildTapRow({
        icon: '▸',
        label: `${menu.name}（${formatMenuPrice(menu)}）`,
        data: `action=pkg1_overhaul_menu&value=${menu.laborId}`,
      }),
    );
    if (i < menus.length - 1) contents.push(buildDivider());
  });
  return buildListBubble({
    altText: 'メニューをお選びください',
    headerTitle: 'メニュー選択',
    headerSubtitle: 'ご希望のメニューをお選びください',
    contents,
  });
}

// ── 違いマトリクス (案 B per-menu cards + 案 A text 補足 in altText) ────────────

/** 1 メニューの違いカード (含まれる機能 ◯ + オプション機能)。 */
function matrixBubble(m: OverhaulMenuMatrix): object {
  const body: object[] = [];
  body.push(buildSectionLabel('✓ 含まれる内容'));
  if (m.includedFeatures.length === 0) {
    body.push(menuBodyText('（店頭でご案内します）'));
  } else {
    for (const name of m.includedFeatures) {
      body.push(featureLine('◯', name, TEXT_PRIMARY));
    }
  }
  if (m.optionalFeatures.length > 0) {
    body.push(buildDivider());
    body.push(buildSectionLabel('＋ オプション'));
    for (const opt of m.optionalFeatures) {
      body.push(featureLine('＋', `${opt.featureName}（${opt.priceLabel}）`, TEXT_MUTED));
    }
  }
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      paddingAll: 'lg',
      backgroundColor: TRYCLE_ORANGE,
      contents: [
        { type: 'text', text: m.menu.name, size: 'lg', weight: 'bold', color: '#ffffff', wrap: true },
        { type: 'text', text: formatMenuPrice(m.menu), size: 'sm', color: '#ffffff', margin: 'xs' },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'none', paddingAll: 'none', contents: body },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: 'none',
      contents: [
        buildTapRow({ icon: '✅', label: 'このメニューにする', data: `action=pkg1_overhaul_menu&value=${m.menu.laborId}` }),
      ],
    },
  };
}

function featureLine(mark: string, text: string, color: string): object {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    paddingStart: 'md',
    paddingEnd: 'md',
    paddingTop: 'xs',
    paddingBottom: 'xs',
    contents: [
      { type: 'text', text: mark, size: 'sm', color: TRYCLE_ORANGE, flex: 0 },
      { type: 'text', text, size: 'sm', color, wrap: true, flex: 1 },
    ],
  };
}

/**
 * 違いマトリクス: メニュー別カード carousel (案 B) + 案 A の text 縦表を altText に併記
 * (LINE プッシュ通知/読み上げに出る)。最後に「メニューの選択に進む」誘導カードを足す。
 */
export function overhaulMatrixMessages(matrix: ReadonlyArray<OverhaulMenuMatrix>): FlexMessage[] {
  const cards = matrix.map(matrixBubble);
  return [
    {
      type: 'flex',
      altText: buildMatrixAltText(matrix),
      contents: { type: 'carousel', contents: cards },
    },
  ];
}

/** 案 A: text-only の縦表 (メニュー名 → 含まれる内容の要約)。altText に入れる。 */
export function buildMatrixAltText(matrix: ReadonlyArray<OverhaulMenuMatrix>): string {
  const lines: string[] = ['【オーバーホールの違い】'];
  for (const m of matrix) {
    const included = m.includedFeatures.length;
    const optional = m.optionalFeatures.length;
    lines.push(`■ ${m.menu.name}（${formatMenuPrice(m.menu)}）`);
    lines.push(`  含まれる内容: ${included}項目${optional > 0 ? ` / オプション${optional}項目` : ''}`);
  }
  // altText は LINE 上限 400 文字。超えるなら切る (carousel が本体なので要約で十分)。
  const text = lines.join('\n');
  return text.length > 390 ? `${text.slice(0, 389)}…` : text;
}

// re-export for callers
export type { LineMessage };
export { DIVIDER_COLOR };
