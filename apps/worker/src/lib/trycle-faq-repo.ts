/**
 * TRYCLE FAQ repo (Phase E-impl Step 2).
 *
 * Tenant Supabase `faqs` テーブル canonical を bot Worker から直接 read する。
 * D1 へ sync する案を当初検討したが、運用簡素化のため canonical 直読みに統一
 * (dashboard 編集が即時反映・mirror 整合性管理不要)。
 *
 * 旧 Vercel 版 (trycle-line-harness/src/lib/faq-repo.ts) を Cloudflare Workers
 * 上の Hono env binding 経由に移植したもの。
 */

import { supabaseSelect, supabaseUpdate } from './supabase.js';
import { getTenantId, type TrycleRepoEnv } from './trycle-repo.js';

export interface FaqRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly question: string;
  readonly answer: string;
  readonly category: string | null;
  readonly tags: string[] | null;
  readonly sort_order: number;
  readonly archived: boolean;
  readonly view_count: number;
  readonly helpful_count: number;
  readonly unhelpful_count: number;
}

const FAQ_COLUMNS =
  'id,tenant_id,question,answer,category,tags,sort_order,archived,view_count,helpful_count,unhelpful_count';

/**
 * active (archived=false) な FAQ を全件返す。category なしの行は末尾に並ぶ。
 * 件数は数十件規模を想定。スケールしてきたら category フィルタを追加する。
 */
export async function listActiveFaqs(env: TrycleRepoEnv): Promise<FaqRow[]> {
  return supabaseSelect<FaqRow>(
    env,
    'faqs',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      archived: `eq.false`,
    },
    {
      select: FAQ_COLUMNS,
      order: 'sort_order.asc',
      limit: 500,
    },
  );
}

/**
 * active FAQ から unique category を昇順で返す。null/空は除外。
 * カテゴリ master を別 table に切り出すまでの暫定実装。
 */
export async function listFaqCategories(env: TrycleRepoEnv): Promise<string[]> {
  const faqs = await listActiveFaqs(env);
  const seen = new Set<string>();
  for (const f of faqs) {
    if (f.category && f.category.trim() !== '') seen.add(f.category);
  }
  return Array.from(seen).sort();
}

export async function getFaqById(env: TrycleRepoEnv, id: string): Promise<FaqRow | null> {
  const rows = await supabaseSelect<FaqRow>(
    env,
    'faqs',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      id: `eq.${id}`,
    },
    { select: FAQ_COLUMNS, limit: 1 },
  );
  return rows[0] ?? null;
}

export type FaqCounterField = 'view_count' | 'helpful_count' | 'unhelpful_count';

/**
 * カウンタを +1 する。PostgREST は increment 構文を持たないため、現在値を読み +1 で書き戻す
 * (競合は許容・FAQ カウンタは厳密一貫性不要)。
 */
export async function incrementFaqCounter(
  env: TrycleRepoEnv,
  id: string,
  field: FaqCounterField,
): Promise<void> {
  const current = await getFaqById(env, id);
  if (!current) return;
  const next = (current[field] ?? 0) + 1;
  await supabaseUpdate(
    env,
    'faqs',
    { tenant_id: `eq.${getTenantId(env)}`, id: `eq.${id}` },
    { [field]: next },
  );
}
