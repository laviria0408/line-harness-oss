/**
 * TRYCLE Pkg8「なんでも質問」(FAQ) postback dispatcher + Quick Reply builder.
 *
 * 設計 v2 (2026-06-21): 横カルーセル廃止・Quick Reply ベースへ刷新。
 *
 *   入口  Rich Menu「FAQ」タップ
 *   ↓     postback data=faq_start
 *   ① テキスト + Quick Reply (人気トップ3 + カテゴリ + スタッフに聞く)
 *   ↓     postback data=faq_cat_{category} or faq_q_{faq_id} or faq_staff
 *   ② カテゴリ選択 → 質問 Quick Reply
 *   ↓     postback data=faq_q_{faq_id}
 *   ③ 回答 Bubble + Quick Reply (解決した / 困った / カテゴリへ戻る)
 *
 * データは Tenant Supabase faqs canonical 直読み (D1 mirror なし)。
 * 業界調査: 横カルーセル使用例ゼロ・Quick Reply が定番。
 */

import type { LineClient } from '@line-crm/line-sdk';
import { quickReply, withQuickReply, type QuickReplyItem } from '@line-crm/line-sdk';
import {
  listActiveFaqs,
  listFaqCategories,
  getFaqById,
  incrementFaqCounter,
  type FaqRow,
} from './trycle-faq-repo.js';
import type { TrycleRepoEnv } from './trycle-repo.js';

const FAQ_PREFIXES = ['faq_', 'pkg8_'] as const;
const QUICK_REPLY_LABEL_MAX = 20;
const TOP_FAQS_COUNT = 3;
const MAX_QUICK_REPLY_ITEMS = 13;

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

  // 未知の faq_/pkg8_ prefix — ack して終了 (auto_reply にも進まない)
  await ctx.lineClient.replyMessage(ctx.replyToken, [
    { type: 'text', text: '承りました。' },
  ]);
  return true;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/**
 * 入口: テキスト + Quick Reply (人気トップ 3 + カテゴリ + スタッフに聞く)
 */
async function replyEntry(ctx: Pkg8Context): Promise<void> {
  const [categories, faqs] = await Promise.all([
    listFaqCategories(ctx.env),
    listActiveFaqs(ctx.env),
  ]);
  if (categories.length === 0 && faqs.length === 0) {
    await ctx.lineClient.replyMessage(ctx.replyToken, [
      { type: 'text', text: '現在ご案内できる FAQ がありません。スタッフへ直接ご連絡ください。' },
    ]);
    return;
  }

  const topFaqs = faqs.slice(0, TOP_FAQS_COUNT);
  const items: QuickReplyItem[] = [];

  // 人気トップ 3 を先頭に
  for (const f of topFaqs) {
    items.push({
      type: 'action',
      action: {
        type: 'postback',
        label: truncateLabel(`⭐ ${f.question}`),
        data: `faq_q_${f.id}`,
      },
    });
  }
  // カテゴリ
  for (const cat of categories) {
    items.push({
      type: 'action',
      action: {
        type: 'postback',
        label: truncateLabel(cat),
        data: `faq_cat_${cat}`,
      },
    });
  }
  // スタッフ送り
  if (items.length < MAX_QUICK_REPLY_ITEMS) {
    items.push({
      type: 'action',
      action: {
        type: 'postback',
        label: '💬 スタッフに聞く',
        data: 'faq_staff',
      },
    });
  }

  const message = withQuickReply(
    {
      type: 'text' as const,
      text: 'よくあるご質問\n下のボタンから知りたいことをお選びください。',
    },
    quickReply(items.slice(0, MAX_QUICK_REPLY_ITEMS)),
  );

  await ctx.lineClient.replyMessage(ctx.replyToken, [message]);
}

/**
 * カテゴリ選択: そのカテゴリの質問を Quick Reply で並べる + 戻る
 */
async function replyQuestionList(ctx: Pkg8Context, category: string): Promise<void> {
  const faqs = await listActiveFaqs(ctx.env);
  const matched = faqs.filter((f) => f.category === category);
  if (matched.length === 0) {
    await ctx.lineClient.replyMessage(ctx.replyToken, [
      { type: 'text', text: `「${category}」カテゴリに該当する質問が見つかりませんでした。` },
    ]);
    return;
  }

  const items: QuickReplyItem[] = [];
  // 質問 (最大 12 件・戻る分 1 を残す)
  for (const f of matched.slice(0, MAX_QUICK_REPLY_ITEMS - 1)) {
    items.push({
      type: 'action',
      action: {
        type: 'postback',
        label: truncateLabel(f.question),
        data: `faq_q_${f.id}`,
      },
    });
  }
  // 戻る
  items.push({
    type: 'action',
    action: {
      type: 'postback',
      label: '← カテゴリへ戻る',
      data: 'faq_start',
    },
  });

  const message = withQuickReply(
    { type: 'text' as const, text: `「${category}」のよくあるご質問` },
    quickReply(items),
  );

  await ctx.lineClient.replyMessage(ctx.replyToken, [message]);
}

/**
 * 質問選択: 回答 Bubble (footer に Quick Reply 風ボタン) + Quick Reply で「カテゴリへ戻る」
 */
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

  // 回答 Bubble (現状の builder を流用)
  const flex = buildAnswerBubble(faq);
  // Quick Reply: カテゴリへ戻る + スタッフに聞く
  const items: QuickReplyItem[] = [
    {
      type: 'action',
      action: {
        type: 'postback',
        label: '← カテゴリへ戻る',
        data: 'faq_start',
      },
    },
    {
      type: 'action',
      action: {
        type: 'postback',
        label: '💬 スタッフに聞く',
        data: 'faq_staff',
      },
    },
  ];
  const message = withQuickReply(flex, quickReply(items));

  await ctx.lineClient.replyMessage(ctx.replyToken, [message]);
}

async function replyHelpfulAck(ctx: Pkg8Context, faqId: string): Promise<void> {
  await incrementFaqCounter(ctx.env, faqId, 'helpful_count').catch((err) => {
    console.error('[trycle-pkg8] helpful_count increment failed', err);
  });
  const items: QuickReplyItem[] = [
    {
      type: 'action',
      action: {
        type: 'postback',
        label: '← カテゴリへ戻る',
        data: 'faq_start',
      },
    },
  ];
  const message = withQuickReply(
    {
      type: 'text' as const,
      text: 'ご回答お役に立てて何よりです。\n他にもご質問があれば下からお選びください。',
    },
    quickReply(items),
  );
  await ctx.lineClient.replyMessage(ctx.replyToken, [message]);
}

async function replyUnhelpfulAck(ctx: Pkg8Context, faqId: string): Promise<void> {
  await incrementFaqCounter(ctx.env, faqId, 'unhelpful_count').catch((err) => {
    console.error('[trycle-pkg8] unhelpful_count increment failed', err);
  });
  const items: QuickReplyItem[] = [
    {
      type: 'action',
      action: {
        type: 'postback',
        label: '💬 スタッフに聞く',
        data: 'faq_staff',
      },
    },
    {
      type: 'action',
      action: {
        type: 'postback',
        label: '← カテゴリへ戻る',
        data: 'faq_start',
      },
    },
  ];
  const message = withQuickReply(
    {
      type: 'text' as const,
      text: 'お役に立てず申し訳ありません。\nご質問の内容をテキストでお送りいただくか、下の「スタッフに聞く」からご連絡ください。',
    },
    quickReply(items),
  );
  await ctx.lineClient.replyMessage(ctx.replyToken, [message]);
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncateLabel(s: string, max: number = QUICK_REPLY_LABEL_MAX): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// ── Flex Message Builder (回答 Bubble は流用) ─────────────────────────────────

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
        paddingAll: 'lg',
      },
    },
  };
}
