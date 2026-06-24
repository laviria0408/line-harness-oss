/**
 * TRYCLE 包括メンテ (A2・Phase 4 v1.6) の Flex builders (状態を持たない純関数)。
 *
 *   overhaulMenuCarousel : 4 メニュー横スワイプ carousel (名前/料金/納期/一言説明)
 *   overhaulMenuPicker   : 「メニューの選択に進む」後の 4 択 縦リスト (名前/料金/一言説明)
 *   overhaulEntryPrompt  : 初期メッセージ + [メニューの選択に進む][違いについて知る]
 *   overhaulMatrixMessages: 違いマトリクス (案 B per-menu cards・含まれる ◯/含まれない × 両表示 + 案 A text 補足 in altText)
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

/** picker 行に出す「一言」。長文 detailed_description を 1 文 / 約 50 字に詰める。 */
const PICKER_SUMMARY_MAX = 50;
export function summarizeDescription(description: string | null): string | null {
  if (!description) return null;
  const trimmed = description.trim();
  if (trimmed.length === 0) return null;
  // 最初の句点までを「一言」とし、無ければ全文を使う。
  const firstSentence = trimmed.split(/(?<=。)/)[0] ?? trimmed;
  const oneLine = (firstSentence.length > 0 ? firstSentence : trimmed).replace(/\s+/g, ' ');
  if (oneLine.length <= PICKER_SUMMARY_MAX) return oneLine;
  return `${oneLine.slice(0, PICKER_SUMMARY_MAX - 1)}…`;
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

/** picker の 1 メニュー行 (名前+料金 / 一言説明 を 2 段で・全体に postback)。 */
function pickerMenuRow(menu: OverhaulMenu): object {
  const lines: object[] = [
    {
      type: 'box',
      layout: 'baseline',
      spacing: 'sm',
      contents: [
        { type: 'text', text: '▸', size: 'md', color: TRYCLE_ORANGE, flex: 0 },
        { type: 'text', text: menu.name, size: 'md', color: TEXT_PRIMARY, weight: 'bold', wrap: true, flex: 1 },
        { type: 'text', text: formatMenuPrice(menu), size: 'sm', color: TRYCLE_ORANGE, align: 'end', flex: 0 },
      ],
    },
  ];
  const summary = summarizeDescription(menu.detailedDescription);
  if (summary) {
    lines.push({
      type: 'text',
      text: summary,
      size: 'xs',
      color: TEXT_MUTED,
      wrap: true,
      margin: 'xs',
      // ▸ + spacing 分インデントして料金/名前の段と視覚的に揃える。
      offsetStart: 'lg',
    });
  }
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'none',
    paddingTop: 'md',
    paddingBottom: 'md',
    paddingStart: 'md',
    paddingEnd: 'md',
    action: { type: 'postback', label: menu.name, data: `action=pkg1_overhaul_menu&value=${menu.laborId}` },
    contents: lines,
  };
}

export function overhaulMenuPicker(menus: ReadonlyArray<OverhaulMenu>): FlexMessage {
  const contents: object[] = [buildSectionLabel('🛠 メニューをお選びください')];
  menus.forEach((menu, i) => {
    contents.push(pickerMenuRow(menu));
    if (i < menus.length - 1) contents.push(buildDivider());
  });
  return buildListBubble({
    altText: 'メニューをお選びください',
    headerTitle: 'メニュー選択',
    headerSubtitle: 'ご希望のメニューをお選びください',
    contents,
  });
}

// ── 違いマトリクス (案 B per-menu cards・含まれる ◯/含まれない × 両表示 + altText) ──

const MARK_INCLUDED = '◯';
const MARK_EXCLUDED = '×';
const COLOR_EXCLUDED = '#cbd5e1'; // × 行は淡いグレーで「無い」感を出す。

/**
 * 全メニューの「含まれる機能」を sort 順を保って union したもの (= 比較対象の機能全集合)。
 * 各カードはこの全集合に対して ◯ / × を出すことで「このメニューに無いもの」が一目でわかる。
 */
export function buildFeatureUniverse(matrix: ReadonlyArray<OverhaulMenuMatrix>): string[] {
  const seen = new Set<string>();
  const universe: string[] = [];
  for (const m of matrix) {
    for (const name of m.includedFeatures) {
      if (!seen.has(name)) {
        seen.add(name);
        universe.push(name);
      }
    }
  }
  return universe;
}

/**
 * 1 メニューの違いカード。機能全集合に対して 含まれる ◯ / 含まれない × を両方並べ、
 * 末尾にオプション機能 (＋) を出す。`universe` は buildFeatureUniverse の結果。
 */
function matrixBubble(m: OverhaulMenuMatrix, universe: ReadonlyArray<string>): object {
  const includedSet = new Set(m.includedFeatures);
  const body: object[] = [];
  body.push(buildSectionLabel('含まれる内容 ◯ / 含まれない ×'));
  if (universe.length === 0) {
    body.push(menuBodyText('（店頭でご案内します）'));
  } else {
    const lines = universe.map((name) =>
      includedSet.has(name)
        ? featureLine(MARK_INCLUDED, name, TEXT_PRIMARY)
        : featureLine(MARK_EXCLUDED, name, COLOR_EXCLUDED, COLOR_EXCLUDED),
    );
    body.push(featureGroup(lines));
  }
  if (m.optionalFeatures.length > 0) {
    body.push(buildDivider());
    body.push(buildSectionLabel('＋ オプション'));
    body.push(
      featureGroup(
        m.optionalFeatures.map((opt) =>
          featureLine('＋', `${opt.featureName}（${opt.priceLabel}）`, TEXT_MUTED),
        ),
      ),
    );
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

/**
 * 1 機能の ◯/×/＋ 行。padding は持たず featureGroup の wrapper に集約する
 * (機能が多いカードでも 1 bubble = LINE 10KB 上限を超えないよう byte を節約)。
 */
function featureLine(mark: string, text: string, color: string, markColor: string = TRYCLE_ORANGE): object {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      { type: 'text', text: mark, size: 'sm', color: markColor, weight: 'bold', flex: 0 },
      { type: 'text', text, size: 'sm', color, wrap: true, flex: 1 },
    ],
  };
}

/** featureLine 群をまとめて左右 padding を 1 回だけ付ける wrapper (byte 節約)。 */
function featureGroup(lines: ReadonlyArray<object>): object {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    paddingStart: 'md',
    paddingEnd: 'md',
    paddingTop: 'xs',
    paddingBottom: 'xs',
    contents: [...lines],
  };
}

/**
 * 違いマトリクス: メニュー別カード carousel (案 B) + 案 A の text 縦表を altText に併記
 * (LINE プッシュ通知/読み上げに出る)。最後に「メニューの選択に進む」誘導カードを足す。
 */
export function overhaulMatrixMessages(matrix: ReadonlyArray<OverhaulMenuMatrix>): FlexMessage[] {
  const universe = buildFeatureUniverse(matrix);
  const cards = matrix.map((m) => matrixBubble(m, universe));
  return [
    {
      type: 'flex',
      altText: buildMatrixAltText(matrix),
      contents: { type: 'carousel', contents: cards },
    },
  ];
}

/** 案 A: text-only の縦表 (メニュー名 → ◯/× の要約)。altText に入れる。 */
export function buildMatrixAltText(matrix: ReadonlyArray<OverhaulMenuMatrix>): string {
  const universe = buildFeatureUniverse(matrix);
  const total = universe.length;
  const lines: string[] = ['【オーバーホールの違い】'];
  for (const m of matrix) {
    const included = m.includedFeatures.length;
    const excluded = Math.max(total - included, 0);
    const optional = m.optionalFeatures.length;
    lines.push(`■ ${m.menu.name}（${formatMenuPrice(m.menu)}）`);
    lines.push(
      `  含まれる ◯${included} / 含まれない ×${excluded}${optional > 0 ? ` / オプション${optional}` : ''}`,
    );
  }
  // altText は LINE 上限 400 文字。超えるなら切る (carousel が本体なので要約で十分)。
  const text = lines.join('\n');
  return text.length > 390 ? `${text.slice(0, 389)}…` : text;
}

// re-export for callers
export type { LineMessage };
export { DIVIDER_COLOR };
