/**
 * TRYCLE Pkg1 labor_options 自動聞きの Flex builder (状態を持たない純関数)。
 *
 * メニュー (variant / 包括メンテ / お悩み候補) 確定後、その親 labor に紐付く
 * labor_options を 1 件ずつ「<オプション名> を追加しますか?」と順次問う。
 * 旧 PWA estimate.js の optionalPartCategories（任意・「不要」も選べる）を
 * labor_options ベースに簡略化した port (task 20260625-004)。
 *
 * - 1 option = 1 bubble (carousel 不要・順次表示)。yes / skip の 2 択。
 * - postback 命名:
 *     action=pkg1_option&value=add:<optionId>   (追加する)
 *     action=pkg1_option&value=skip:<optionId>  (不要・スキップ)
 *   value に optionId を埋めるのは、古い bubble (stale) を押したときに
 *   「今問うている option と違う」ことを handler 側で検知できるようにするため。
 *
 * 表示は Pkg8/Pkg1 共通の buildListBubble / buildTapRow / buildSectionLabel に乗せる。
 * 1 bubble の JSON は LINE 上限 10240 byte に十分収まる軽量 Flex。
 */
import {
  buildTapRow,
  buildSectionLabel,
  buildDivider,
  buildListBubble,
  type FlexMessage,
} from './trycle-flex-helpers.js';
import type { LaborOptionRow } from './trycle-pkg1-repo.js';

/** price=0 の「要相談」オプション用の金額表記。 */
const PRICE_TBD_LABEL = '要相談';

/**
 * オプション 1 件の金額表記。price>0 → "+¥12,000" / price=0 → "要相談"。
 * 0 円は無料でなく金額未確定 (notes に「お見積もり要相談」が入る) ため明示する。
 */
export function formatOptionPrice(option: Pick<LaborOptionRow, 'price'>): string {
  if (option.price > 0) return `+¥${option.price.toLocaleString('ja-JP')}`;
  return PRICE_TBD_LABEL;
}

/**
 * 単一 option の yes/no 問い Flex bubble を組む。
 *
 * @param option         今問うているオプション 1 件。
 * @param remainingCount このオプションを含む「残り問う件数」(>=1)。subtitle に出す。
 */
export function buildOptionPromptBubble(
  option: LaborOptionRow,
  remainingCount: number,
): FlexMessage {
  const priceLabel = formatOptionPrice(option);
  const title = `${option.name}（${priceLabel}）`;
  const contents: object[] = [buildSectionLabel(`${title} を追加しますか?`)];
  if (option.notes) {
    contents.push({
      type: 'box',
      layout: 'vertical',
      paddingStart: 'md',
      paddingEnd: 'md',
      paddingBottom: 'sm',
      contents: [{ type: 'text', text: option.notes, size: 'xs', color: '#64748b', wrap: true }],
    });
    contents.push(buildDivider());
  }
  contents.push(
    buildTapRow({ icon: '✅', label: '追加する', data: `action=pkg1_option&value=add:${option.id}` }),
  );
  contents.push(buildDivider());
  contents.push(
    buildTapRow({ icon: '⏭', label: '不要・スキップ', data: `action=pkg1_option&value=skip:${option.id}` }),
  );

  const subtitle = remainingCount > 1 ? `オプション (残り${remainingCount}件)` : 'オプション';
  return buildListBubble({
    altText: `${title} を追加しますか?`,
    headerTitle: 'オプションの追加',
    headerSubtitle: subtitle,
    contents,
    size: 'mega',
  });
}
