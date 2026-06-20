/**
 * TRYCLE Pkg8「なんでも質問」(FAQ) postback dispatcher + Flex Message builder.
 *
 * 設計 (Phase E-impl Step 2):
 *   入口  Rich Menu「FAQ」タップ
 *   ↓     postback data=faq_start
 *   ① カテゴリ Flex Carousel
 *   ↓     postback data=faq_cat_{category}
 *   ② 質問 Flex Carousel (10 件まで)
 *   ↓     postback data=faq_q_{faq_id}
 *   ③ 回答 Bubble + Quick Reply (解決した / 困った)
 *           postback data=faq_h_{faq_id} (helpful)
 *           postback data=faq_u_{faq_id} (unhelpful)
 *
 * データは Tenant Supabase faqs canonical 直読み (D1 mirror なし)。
 */

import type { LineClient } from '@line-crm/line-sdk';
import {
  listActiveFaqs,
  listFaqCategories,
  getFaqById,
  incrementFaqCounter,
  type FaqRow,
} from './trycle-faq-repo.js';
import type { TrycleRepoEnv } from './trycle-repo.js';

const FAQ_PREFIXES = ['faq_', 'pkg8_'] as const;
const QUESTIONS_PER_CAROUSEL = 10;

export function isPkg8Postback(data: string): boolean {
  return FAQ_PREFIXES.some((prefix) => data.startsWith(prefix));
}

export interface Pkg8Context {
  readonly replyToken: string;
  readonly lineUserId: string;
  readonly lineClient: LineClient;
  readonly env: TrycleRepoEnv;
}

interface FlexMessage {
  readonly type: 'flex';
  readonly altText: string;
  readonly contents: object;
}

/**
 * Returns true if handled (caller MUST NOT continue with auto-reply matching).
 * Returns false if the data is not a Pkg8 prefix.
 */
export async function handlePkg8Postback(data: string, ctx: Pkg8Context): Promise<boolean> {
  if (!isPkg8Postback(data)) return false;

  try {
    if (data === 'faq_start' || data === 'pkg8_start') {
      await replyCategoryList(ctx);
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

  // 未知の faq_/pkg8_ prefix — ack して終了 (auto_reply にも進まない)
  await ctx.lineClient.replyMessage(ctx.replyToken, [
    { type: 'text', text: '承りました。' },
  ]);
  return true;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function replyCategoryList(ctx: Pkg8Context): Promise<void> {
  const [categories, faqs] = await Promise.all([
    listFaqCategories(ctx.env),
    listActiveFaqs(ctx.env),
  ]);
  if (categories.length === 0) {
    await ctx.lineClient.replyMessage(ctx.replyToken, [
      { type: 'text', text: '現在ご案内できる FAQ がありません。スタッフへ直接ご連絡ください。' },
    ]);
    return;
  }
  const countByCategory = new Map<string, number>();
  for (const f of faqs) {
    if (!f.category) continue;
    countByCategory.set(f.category, (countByCategory.get(f.category) ?? 0) + 1);
  }
  const flex = buildCategoryCarousel(categories, countByCategory);
  await ctx.lineClient.replyMessage(ctx.replyToken, [flex]);
}

async function replyQuestionList(ctx: Pkg8Context, category: string): Promise<void> {
  const faqs = await listActiveFaqs(ctx.env);
  const matched = faqs.filter((f) => f.category === category).slice(0, QUESTIONS_PER_CAROUSEL);
  if (matched.length === 0) {
    await ctx.lineClient.replyMessage(ctx.replyToken, [
      { type: 'text', text: `「${category}」カテゴリに該当する質問が見つかりませんでした。` },
    ]);
    return;
  }
  const flex = buildQuestionCarousel(matched, category);
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
  const flex = buildAnswerBubble(faq);
  await ctx.lineClient.replyMessage(ctx.replyToken, [flex]);
}

async function replyHelpfulAck(ctx: Pkg8Context, faqId: string): Promise<void> {
  await incrementFaqCounter(ctx.env, faqId, 'helpful_count').catch((err) => {
    console.error('[trycle-pkg8] helpful_count increment failed', err);
  });
  await ctx.lineClient.replyMessage(ctx.replyToken, [
    {
      type: 'text',
      text: 'ご回答お役に立てて何よりです。他にもご質問があればメニューから「FAQ」をお選びください。',
    },
  ]);
}

async function replyUnhelpfulAck(ctx: Pkg8Context, faqId: string): Promise<void> {
  await incrementFaqCounter(ctx.env, faqId, 'unhelpful_count').catch((err) => {
    console.error('[trycle-pkg8] unhelpful_count increment failed', err);
  });
  await ctx.lineClient.replyMessage(ctx.replyToken, [
    {
      type: 'text',
      text: 'お役に立てず申し訳ありません。スタッフから折り返しご連絡いたしますので、ご質問の内容をテキストでお送りください。',
    },
  ]);
}

// ── Flex Message Builders ────────────────────────────────────────────────────

function buildCategoryCarousel(
  categories: string[],
  countByCategory: Map<string, number>,
): FlexMessage {
  // Carousel は最大 12 bubble。13 件以上は先頭 12 (運用上稀)
  const limited = categories.slice(0, 12);
  return {
    type: 'flex',
    altText: 'よくあるご質問のカテゴリ一覧',
    contents: {
      type: 'carousel',
      contents: limited.map((cat) => ({
        type: 'bubble',
        size: 'kilo',
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: cat, weight: 'bold', size: 'lg', color: '#1e293b', wrap: true },
          ],
          paddingAll: 'md',
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: `${countByCategory.get(cat) ?? 0} 件の質問`,
              size: 'sm',
              color: '#64748b',
            },
          ],
          paddingAll: 'md',
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: '#06C755',
              action: { type: 'postback', label: '質問を見る', data: `faq_cat_${cat}` },
              height: 'sm',
            },
          ],
          paddingAll: 'md',
        },
      })),
    },
  };
}

function buildQuestionCarousel(faqs: FaqRow[], category: string): FlexMessage {
  const bubbles: object[] = faqs.map((f) => ({
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: category, size: 'xs', color: '#64748b' },
        { type: 'text', text: f.question, weight: 'bold', size: 'md', wrap: true, margin: 'sm', color: '#1e293b' },
      ],
      paddingAll: 'md',
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#06C755',
          action: { type: 'postback', label: 'この質問を見る', data: `faq_q_${f.id}` },
          height: 'sm',
        },
      ],
      paddingAll: 'md',
    },
  }));

  // 末尾に「別のカテゴリへ戻る」bubble
  bubbles.push({
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: '別のカテゴリ', size: 'xs', color: '#64748b' },
        { type: 'text', text: '他の質問を探す', weight: 'bold', size: 'md', wrap: true, margin: 'sm', color: '#1e293b' },
      ],
      paddingAll: 'md',
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          style: 'secondary',
          action: { type: 'postback', label: 'カテゴリへ戻る', data: 'faq_start' },
          height: 'sm',
        },
      ],
      paddingAll: 'md',
    },
  });

  return {
    type: 'flex',
    altText: `${category} の質問一覧`,
    contents: { type: 'carousel', contents: bubbles },
  };
}

function buildAnswerBubble(faq: FaqRow): FlexMessage {
  return {
    type: 'flex',
    altText: faq.question,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: faq.category ?? 'FAQ', size: 'xs', color: '#64748b' },
          {
            type: 'text',
            text: faq.question,
            weight: 'bold',
            size: 'md',
            wrap: true,
            color: '#1e293b',
            margin: 'sm',
          },
        ],
        paddingAll: 'lg',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: faq.answer, size: 'sm', color: '#1e293b', wrap: true },
        ],
        paddingAll: 'lg',
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: '#06C755',
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
            action: { type: 'postback', label: '別のカテゴリへ戻る', data: 'faq_start' },
            height: 'sm',
          },
        ],
        paddingAll: 'lg',
      },
    },
  };
}
