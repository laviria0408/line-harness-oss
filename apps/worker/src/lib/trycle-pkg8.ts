/**
 * TRYCLE Pkg8「なんでも質問」(FAQ) postback dispatcher + Flex 縦リスト builder.
 *
 * 設計 v3 (2026-06-21): Quick Reply (横スライダー) も「画面下スライダー」のため
 * user 指摘「縦並びにして」を満たさず再度刷新。Flex Bubble の縦リスト形式に変更。
 *
 *   入口  Rich Menu「FAQ」タップ
 *   ↓     postback data=faq_start
 *   ① Flex 縦リスト (人気トップ3 + カテゴリ + スタッフに聞く)
 *   ↓     postback data=faq_cat_{category} or faq_q_{faq_id} or faq_staff
 *   ② カテゴリ選択 → そのカテゴリの質問が縦に並ぶ Flex Bubble
 *   ↓     postback data=faq_q_{faq_id}
 *   ③ 回答 Bubble (header=質問 / body=回答 / footer=[解決した][困った][戻る])
 *
 * データは Tenant Supabase faqs canonical 直読み (D1 mirror なし)。
 */

import type { LineClient } from '@line-crm/line-sdk';
import {
  listActiveFaqs,
  listFaqCategories,
  listTopViewedFaqs,
  searchFaqs,
  getFaqById,
  incrementFaqCounter,
  type FaqRow,
  type FaqLinkRow,
} from './trycle-faq-repo.js';
import type { TrycleRepoEnv } from './trycle-repo.js';
import { appendChatSummary } from './trycle-chat-summary.js';
import {
  buildTapRow,
  buildSectionLabel,
  buildDivider,
  TRYCLE_GREEN,
  TEXT_PRIMARY,
  TEXT_MUTED,
  type FlexMessage,
} from './trycle-flex-helpers.js';

const FAQ_PREFIXES = ['faq_', 'pkg8_'] as const;
const TOP_FAQS_COUNT = 3;
const SEARCH_RESULTS_LIMIT = 5;
const MIN_SEARCH_QUERY_LENGTH = 2;

export function isPkg8Postback(data: string): boolean {
  return FAQ_PREFIXES.some((prefix) => data.startsWith(prefix));
}

export interface Pkg8Context {
  readonly replyToken: string;
  readonly lineUserId: string;
  readonly lineClient: LineClient;
  readonly env: TrycleRepoEnv;
}

export async function handlePkg8Postback(data: string, ctx: Pkg8Context): Promise<boolean> {
  if (!isPkg8Postback(data)) return false;

  try {
    if (data === 'faq_start' || data === 'pkg8_start') {
      await replyEntry(ctx);
      return true;
    }
    if (data === 'faq_staff') {
      await replyStaffEscalation(ctx);
      return true;
    }
    if (data.startsWith('faq_cat_')) {
      const category = data.slice('faq_cat_'.length);
      await replyQuestionList(ctx, category);
      return true;
    }
    if (data.startsWith('faq_q_')) {
      const faqId = data.slice('faq_q_'.length);
      await replyAnswer(ctx, faqId);
      return true;
    }
    if (data.startsWith('faq_h_')) {
      const faqId = data.slice('faq_h_'.length);
      await replyHelpfulAck(ctx, faqId);
      return true;
    }
    if (data.startsWith('faq_u_')) {
      const faqId = data.slice('faq_u_'.length);
      await replyUnhelpfulAck(ctx, faqId);
      return true;
    }
  } catch (err) {
    console.error('[trycle-pkg8] handle failed', err);
    try {
      await ctx.lineClient.replyMessage(ctx.replyToken, [
        { type: 'text', text: 'FAQ の取得に失敗しました。少し時間をおいて再度お試しください。' },
      ]);
    } catch (replyErr) {
      console.error('[trycle-pkg8] error reply failed', replyErr);
    }
    return true;
  }

  await ctx.lineClient.replyMessage(ctx.replyToken, [{ type: 'text', text: '承りました。' }]);
  return true;
}

/**
 * 自由入力テキストに対する FAQ 検索ハンドラ。webhook.ts の text 経路で
 * LH 標準 auto_reply が match しなかった時に呼ぶ。
 *
 * Returns true if handled (caller MUST NOT continue with fallback).
 * Returns false if the query is too short or no action taken.
 */
export async function handlePkg8Text(text: string, ctx: Pkg8Context): Promise<boolean> {
  const query = text.trim();
  if (query.length < MIN_SEARCH_QUERY_LENGTH) return false;

  try {
    const hits = await searchFaqs(ctx.env, query, SEARCH_RESULTS_LIMIT);
    if (hits.length === 0) {
      await replyNoHit(ctx, query);
      return true;
    }
    if (hits.length === 1) {
      // 1 件ヒット → そのまま回答
      await incrementFaqCounter(ctx.env, hits[0]!.id, 'view_count').catch((err) => {
        console.error('[trycle-pkg8] view_count increment failed', err);
      });
      // なんでも質問 (自由入力) + bot 応答 (2 行)。flow は inquiry 扱い。
      await appendChatSummary(ctx.env, ctx.lineUserId, { flowType: 'inquiry', speaker: '顧客', text: query });
      await appendChatSummary(ctx.env, ctx.lineUserId, { flowType: 'inquiry', speaker: 'bot', text: hits[0]!.answer });
      const flex = buildAnswerBubble(hits[0]!);
      await ctx.lineClient.replyMessage(ctx.replyToken, [flex]);
      return true;
    }
    // 2-5 件 → 候補リスト
    const flex = buildSearchResultsBubble(query, hits);
    await ctx.lineClient.replyMessage(ctx.replyToken, [flex]);
    return true;
  } catch (err) {
    console.error('[trycle-pkg8] handlePkg8Text failed', err);
    return false;
  }
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function replyEntry(ctx: Pkg8Context): Promise<void> {
  // 人気トップ 3 = view_count desc・カテゴリ一覧 = distinct from active faqs
  const [topFaqs, categories, faqsCount] = await Promise.all([
    listTopViewedFaqs(ctx.env, TOP_FAQS_COUNT),
    listFaqCategories(ctx.env),
    listActiveFaqs(ctx.env).then((f) => f.length),
  ]);
  if (categories.length === 0 && faqsCount === 0) {
    await ctx.lineClient.replyMessage(ctx.replyToken, [
      { type: 'text', text: '現在ご案内できる FAQ がありません。スタッフへ直接ご連絡ください。' },
    ]);
    return;
  }

  // 閲覧数が 0 の FAQ は人気として出さない (新規 deploy 直後は空)
  const topFaqsFiltered = topFaqs.filter((f) => f.view_count > 0);
  const flex = buildEntryBubble(topFaqsFiltered, categories);
  await ctx.lineClient.replyMessage(ctx.replyToken, [flex]);
}

async function replyQuestionList(ctx: Pkg8Context, category: string): Promise<void> {
  const faqs = await listActiveFaqs(ctx.env);
  const matched = faqs.filter((f) => f.category === category);
  if (matched.length === 0) {
    await ctx.lineClient.replyMessage(ctx.replyToken, [
      { type: 'text', text: `「${category}」カテゴリに該当する質問が見つかりませんでした。` },
    ]);
    return;
  }
  const flex = buildQuestionListBubble(category, matched);
  await ctx.lineClient.replyMessage(ctx.replyToken, [flex]);
}

async function replyAnswer(ctx: Pkg8Context, faqId: string): Promise<void> {
  const faq = await getFaqById(ctx.env, faqId);
  if (!faq) {
    await ctx.lineClient.replyMessage(ctx.replyToken, [
      { type: 'text', text: '該当する質問が見つかりませんでした。' },
    ]);
    return;
  }
  await incrementFaqCounter(ctx.env, faqId, 'view_count').catch((err) => {
    console.error('[trycle-pkg8] view_count increment failed', err);
  });
  // FAQ 選択 + 応答 (2 行)。直近 case があれば append・無ければバッファ。
  await appendChatSummary(ctx.env, ctx.lineUserId, { flowType: 'pkg8', speaker: '顧客', text: faq.question });
  await appendChatSummary(ctx.env, ctx.lineUserId, { flowType: 'pkg8', speaker: 'bot', text: faq.answer });
  const flex = buildAnswerBubble(faq);
  await ctx.lineClient.replyMessage(ctx.replyToken, [flex]);
}

async function replyHelpfulAck(ctx: Pkg8Context, faqId: string): Promise<void> {
  await incrementFaqCounter(ctx.env, faqId, 'helpful_count').catch((err) => {
    console.error('[trycle-pkg8] helpful_count increment failed', err);
  });
  const flex = buildAckBubble(
    'ご回答お役に立てて何よりです',
    '他にもご質問があれば下のボタンからお戻りください。',
    [{ label: '← FAQ に戻る', data: 'faq_start', style: 'primary' }],
  );
  await ctx.lineClient.replyMessage(ctx.replyToken, [flex]);
}

async function replyUnhelpfulAck(ctx: Pkg8Context, faqId: string): Promise<void> {
  await incrementFaqCounter(ctx.env, faqId, 'unhelpful_count').catch((err) => {
    console.error('[trycle-pkg8] unhelpful_count increment failed', err);
  });
  const flex = buildAckBubble(
    'お役に立てず申し訳ありません',
    'スタッフへエスカレーションいたします。下から続けてください。',
    [
      { label: '💬 スタッフに聞く', data: 'faq_staff', style: 'primary' },
      { label: '← FAQ に戻る', data: 'faq_start', style: 'secondary' },
    ],
  );
  await ctx.lineClient.replyMessage(ctx.replyToken, [flex]);
}

async function replyNoHit(ctx: Pkg8Context, query: string): Promise<void> {
  const flex = buildAckBubble(
    'ご質問を承りました',
    `「${query.length > 30 ? query.slice(0, 30) + '…' : query}」について、該当する FAQ が見つかりませんでした。\nスタッフから折り返しご連絡いたしますので、もう少々お待ちください。`,
    [
      { label: '← FAQ メニューを開く', data: 'faq_start', style: 'secondary' },
    ],
  );
  await ctx.lineClient.replyMessage(ctx.replyToken, [flex]);
}

async function replyStaffEscalation(ctx: Pkg8Context): Promise<void> {
  await ctx.lineClient.replyMessage(ctx.replyToken, [
    {
      type: 'text',
      text:
        'スタッフからご連絡いたします。\nご質問の内容をこちらにテキストでお送りください。\n営業時間内に順次お返事いたします。',
    },
  ]);
}

// ── Flex Builders ────────────────────────────────────────────────────────────
// 共通 helper (buildTapRow / buildSectionLabel / buildDivider) と色定数は
// trycle-flex-helpers.ts に集約済み (Pkg1 と共有・LH 準拠 1 Bubble 縦リスト型)。

function buildEntryBubble(topFaqs: FaqRow[], categories: string[]): FlexMessage {
  const contents: object[] = [];

  if (topFaqs.length > 0) {
    contents.push(buildSectionLabel('⭐ よくある質問'));
    for (const f of topFaqs) {
      contents.push(buildTapRow({ icon: '▸', label: f.question, data: `faq_q_${f.id}` }));
      contents.push(buildDivider());
    }
  }

  if (categories.length > 0) {
    contents.push(buildSectionLabel('📂 カテゴリから探す'));
    for (const cat of categories) {
      contents.push(buildTapRow({ icon: '▸', label: cat, data: `faq_cat_${cat}` }));
      contents.push(buildDivider());
    }
  }

  contents.push(buildTapRow({ icon: '💬', label: 'スタッフに直接聞く', data: 'faq_staff' }));

  return {
    type: 'flex',
    altText: 'よくあるご質問',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        backgroundColor: TRYCLE_GREEN,
        contents: [
          { type: 'text', text: 'よくあるご質問', size: 'lg', weight: 'bold', color: '#ffffff' },
          {
            type: 'text',
            text: '知りたいことを下からタップしてね',
            size: 'sm',
            color: '#ffffff',
            margin: 'xs',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'none',
        paddingAll: 'none',
        contents,
      },
    },
  };
}

function buildQuestionListBubble(category: string, faqs: FaqRow[]): FlexMessage {
  const contents: object[] = [];
  for (const f of faqs) {
    contents.push(buildTapRow({ icon: '▸', label: f.question, data: `faq_q_${f.id}` }));
    contents.push(buildDivider());
  }
  contents.push(buildTapRow({ icon: '←', label: 'カテゴリへ戻る', data: 'faq_start' }));

  return {
    type: 'flex',
    altText: `${category} のよくあるご質問`,
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        backgroundColor: TRYCLE_GREEN,
        contents: [
          { type: 'text', text: category, size: 'lg', weight: 'bold', color: '#ffffff' },
          {
            type: 'text',
            text: `${faqs.length} 件の質問`,
            size: 'sm',
            color: '#ffffff',
            margin: 'xs',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'none',
        paddingAll: 'none',
        contents,
      },
    },
  };
}

function buildSearchResultsBubble(query: string, faqs: FaqRow[]): FlexMessage {
  const contents: object[] = [];
  for (const f of faqs) {
    const labelWithCategory = f.category ? `${f.question}` : f.question;
    contents.push(buildTapRow({ icon: '▸', label: labelWithCategory, data: `faq_q_${f.id}` }));
    contents.push(buildDivider());
  }
  contents.push(buildTapRow({ icon: '←', label: 'FAQ メニューへ', data: 'faq_start' }));

  const shortQuery = query.length > 20 ? query.slice(0, 20) + '…' : query;
  return {
    type: 'flex',
    altText: `「${shortQuery}」の検索結果`,
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        backgroundColor: TRYCLE_GREEN,
        contents: [
          { type: 'text', text: 'こちらのご質問でしょうか？', size: 'md', weight: 'bold', color: '#ffffff', wrap: true },
          {
            type: 'text',
            text: `「${shortQuery}」の検索結果 ${faqs.length} 件`,
            size: 'xs',
            color: '#ffffff',
            margin: 'xs',
            wrap: true,
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'none',
        paddingAll: 'none',
        contents,
      },
    },
  };
}

/** LINE footer は縦に伸びすぎると見切れるため、リンクボタンは上位 N 件のみ表示する。 */
const MAX_FAQ_LINK_BUTTONS = 3;

/**
 * REQ-PKG8-008: faq_links を LINE button に変換する。
 * action_type='uri'      → 外部リンク (url 必須)
 * action_type='postback' → bot 内遷移 (postback_data 必須)
 * 不整合 (uri なのに url が null 等) な行は安全側で除外する。
 */
export function buildLinkButtons(links: FaqLinkRow[]): object[] {
  const buttons: object[] = [];
  for (const link of links) {
    if (buttons.length >= MAX_FAQ_LINK_BUTTONS) break;
    if (link.action_type === 'uri') {
      if (!link.url) continue; // 不整合 (uri なのに url なし) は安全側で除外
      buttons.push({
        type: 'button',
        style: 'secondary',
        height: 'sm',
        action: { type: 'uri', label: link.label, uri: link.url },
      });
      continue;
    }
    if (!link.postback_data) continue; // 不整合 (postback なのに data なし) は除外
    buttons.push({
      type: 'button',
      style: 'secondary',
      height: 'sm',
      action: { type: 'postback', label: link.label, data: link.postback_data },
    });
  }
  return buttons;
}

export function buildAnswerBubble(faq: FaqRow): FlexMessage {
  const bodyContents: object[] = [
    { type: 'text', text: faq.answer, size: 'sm', color: TEXT_PRIMARY, wrap: true },
  ];
  // REQ-PKG8-006: フォローアップ案内を回答の下に追記 (truthy なときのみ)。
  if (faq.follow_up && faq.follow_up.trim() !== '') {
    bodyContents.push(buildDivider());
    bodyContents.push({
      type: 'text',
      text: faq.follow_up,
      size: 'sm',
      color: TEXT_MUTED,
      wrap: true,
      margin: 'md',
    });
  }

  // REQ-PKG8-008: リンクボタンは [解決した][困った][戻る] の上に配置。
  const linkButtons = buildLinkButtons(faq.links);

  return {
    type: 'flex',
    altText: faq.question,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: faq.category ?? 'FAQ', size: 'xs', color: TEXT_MUTED },
          {
            type: 'text',
            text: faq.question,
            weight: 'bold',
            size: 'md',
            wrap: true,
            color: TEXT_PRIMARY,
            margin: 'sm',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        contents: bodyContents,
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'lg',
        contents: [
          ...linkButtons,
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: TRYCLE_GREEN,
                action: { type: 'postback', label: '解決した', data: `faq_h_${faq.id}` },
                height: 'sm',
                flex: 1,
              },
              {
                type: 'button',
                style: 'secondary',
                action: { type: 'postback', label: '困った', data: `faq_u_${faq.id}` },
                height: 'sm',
                flex: 1,
              },
            ],
          },
          {
            type: 'button',
            style: 'link',
            action: { type: 'postback', label: '← FAQ に戻る', data: 'faq_start' },
            height: 'sm',
          },
        ],
      },
    },
  };
}

function buildAckBubble(
  title: string,
  body: string,
  buttons: ReadonlyArray<{ label: string; data: string; style: 'primary' | 'secondary' }>,
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
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'lg',
        contents: buttons.map((b) => ({
          type: 'button',
          style: b.style,
          color: b.style === 'primary' ? TRYCLE_GREEN : undefined,
          action: { type: 'postback', label: b.label, data: b.data },
          height: 'sm',
        })),
      },
    },
  };
}
