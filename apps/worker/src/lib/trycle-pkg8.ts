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
  getFaqById,
  incrementFaqCounter,
  type FaqRow,
} from './trycle-faq-repo.js';
import type { TrycleRepoEnv } from './trycle-repo.js';

const FAQ_PREFIXES = ['faq_', 'pkg8_'] as const;
const TOP_FAQS_COUNT = 3;
const TRYCLE_GREEN = '#06C755';
const TEXT_PRIMARY = '#1e293b';
const TEXT_MUTED = '#64748b';
const DIVIDER_COLOR = '#e2e8f0';

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

interface TapRow {
  icon: string;
  label: string;
  data: string;
}

function buildTapRow(row: TapRow): object {
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

function buildSectionLabel(text: string): object {
  return {
    type: 'box',
    layout: 'vertical',
    paddingTop: 'md',
    paddingBottom: 'sm',
    paddingStart: 'md',
    paddingEnd: 'md',
    contents: [
      { type: 'text', text, size: 'sm', color: TEXT_MUTED, weight: 'bold' },
    ],
  };
}

function buildDivider(): object {
  return { type: 'separator', color: DIVIDER_COLOR };
}

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
        contents: [
          { type: 'text', text: faq.answer, size: 'sm', color: TEXT_PRIMARY, wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'lg',
        contents: [
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
