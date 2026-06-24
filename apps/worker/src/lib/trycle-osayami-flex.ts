/**
 * TRYCLE Pkg1「お悩み」マッチング (A1・Phase 4 v1.6) の Flex builders (純関数)。
 *
 *   osayamiInputPrompt   : 「お悩みを教えてください」自由文入力の前置き (postback なし)
 *   osayamiResultMessages: マッチ 3 件 carousel + [このメニューで/もう一度/スタッフ相談]
 *   osayamiNoMatchPrompt : 0 件 fallback (スタッフに相談しますか?)
 *
 * 候補カードは TRYCLE 緑 (通常 region と統一)。残回数は呼び出し側が文言で渡す。
 * postback 命名:
 *   - action=pkg1_osayami&value=pick:{index}   候補確定 (osayamiCandidates[index])
 *   - action=pkg1_osayami&value=again          もう一度質問する
 *   - action=pkg1_osayami&value=staff          スタッフに相談する
 *
 * 設計: Pkg1 v1.6 (page 386050ad6a7e81f8b701cd52c9201af6)。
 */
import {
  buildTapRow,
  buildSectionLabel,
  buildDivider,
  buildListBubble,
  TRYCLE_GREEN,
  type FlexMessage,
} from './trycle-flex-helpers.js';
import { formatItemPrice, type QuoteLineItem } from './quote.js';
import type { LineMessage } from './trycle-pkg1-flex.js';

const TEXT_PRIMARY = '#1e293b';
const TEXT_MUTED = '#64748b';

/** お悩み入力の前置きテキスト (text input を促す・postback を持たない)。 */
export function osayamiInputText(remainingLoops: number): string {
  const remain = remainingLoops > 0 ? `\n（あと ${remainingLoops} 回までお伺いできます）` : '';
  return (
    'どのようなことでお困りですか？\n' +
    '気になる症状やご希望を文章でお送りください。\n' +
    '例：「ブレーキの効きが悪い」「全体的に点検してほしい」' +
    remain
  );
}

/** 候補 1 件の表示用素材。 */
export interface OsayamiCandidateView {
  readonly name: string;
  /** 料金表示 (formatItemPrice 互換)。 */
  readonly priceLabel: string;
  /** 任意の補足 (description 抜粋等)。 */
  readonly note?: string | null;
}

/** QuoteLineItem (cart に積む前) から候補 view を作る。 */
export function candidateViewFromItem(item: QuoteLineItem, note?: string | null): OsayamiCandidateView {
  return {
    name: item.name,
    priceLabel: formatItemPrice(item),
    note: note ?? null,
  };
}

/** 候補 1 件の carousel bubble (緑ヘッダ + 料金 + 確定ボタン)。 */
function candidateBubble(view: OsayamiCandidateView, index: number): object {
  const body: object[] = [
    {
      type: 'box',
      layout: 'horizontal',
      paddingStart: 'md',
      paddingEnd: 'md',
      paddingTop: 'sm',
      paddingBottom: 'sm',
      contents: [
        { type: 'text', text: '目安料金', size: 'sm', color: TEXT_MUTED, flex: 2 },
        { type: 'text', text: view.priceLabel, size: 'sm', color: TEXT_PRIMARY, weight: 'bold', align: 'end', flex: 3, wrap: true },
      ],
    },
  ];
  if (view.note) {
    body.push(buildDivider());
    body.push({
      type: 'box',
      layout: 'vertical',
      paddingStart: 'md',
      paddingEnd: 'md',
      paddingTop: 'sm',
      paddingBottom: 'sm',
      contents: [{ type: 'text', text: view.note, size: 'xs', color: TEXT_MUTED, wrap: true }],
    });
  }
  body.push(buildDivider());
  body.push(buildTapRow({ icon: '✅', label: 'このメニューにする', data: `action=pkg1_osayami&value=pick:${index}` }));

  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      paddingAll: 'lg',
      backgroundColor: TRYCLE_GREEN,
      contents: [
        { type: 'text', text: `候補 ${index + 1}`, size: 'xs', color: '#ffffff' },
        { type: 'text', text: view.name, size: 'md', weight: 'bold', color: '#ffffff', wrap: true, margin: 'xs' },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'none', paddingAll: 'none', contents: body },
  };
}

/**
 * マッチ結果メッセージ: 候補 carousel + 操作 3 択 (もう一度/スタッフ相談)。
 * remainingLoops <= 0 のときは「もう一度質問する」を出さない (上限到達直前)。
 */
export function osayamiResultMessages(
  candidates: ReadonlyArray<OsayamiCandidateView>,
  remainingLoops: number,
): FlexMessage[] {
  const carousel: FlexMessage = {
    type: 'flex',
    altText: 'お悩みに近いメンテナンスメニューの候補',
    contents: { type: 'carousel', contents: candidates.map((c, i) => candidateBubble(c, i)) },
  };

  const actionContents: object[] = [buildSectionLabel('ご希望に近いメニューを選んでください')];
  if (remainingLoops > 0) {
    actionContents.push(
      buildTapRow({ icon: '🔁', label: `もう一度質問する（あと ${remainingLoops} 回）`, data: 'action=pkg1_osayami&value=again' }),
    );
    actionContents.push(buildDivider());
  }
  actionContents.push(
    buildTapRow({ icon: '💬', label: 'スタッフに相談する', data: 'action=pkg1_osayami&value=staff' }),
  );

  const actions = buildListBubble({
    altText: 'このメニューでよろしいですか？',
    headerTitle: 'ご確認',
    headerSubtitle: 'このメニューでいかがでしょうか？',
    contents: actionContents,
  });

  return [carousel, actions];
}

/** 0 件 fallback: スタッフ相談へ誘導する 1 Bubble。 */
export function osayamiNoMatchPrompt(): FlexMessage {
  return buildListBubble({
    altText: '該当が見つかりませんでした',
    headerTitle: '該当が見つかりませんでした',
    headerSubtitle: 'スタッフがご相談を承ります',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        paddingStart: 'md',
        paddingEnd: 'md',
        paddingTop: 'sm',
        paddingBottom: 'sm',
        contents: [
          {
            type: 'text',
            text: 'ご入力内容に近いメニューが見つかりませんでした。\nスタッフがご相談を承りますか？',
            size: 'sm',
            color: TEXT_PRIMARY,
            wrap: true,
          },
        ],
      },
      buildDivider(),
      buildTapRow({ icon: '💬', label: 'スタッフに相談する', data: 'action=pkg1_osayami&value=staff' }),
      buildDivider(),
      buildTapRow({ icon: '🔁', label: 'もう一度質問する', data: 'action=pkg1_osayami&value=again' }),
    ],
  });
}

export type { LineMessage };
