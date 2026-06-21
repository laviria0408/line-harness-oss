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

/**
 * FAQ 回答に紐づくリンクボタン (REQ-PKG8-008)。
 * action_type='uri'      → url を開く外部リンク
 * action_type='postback' → postback_data で bot 内遷移
 * 1 FAQ : N links。dashboard PWA の faq_links テーブル canonical。
 */
export interface FaqLinkRow {
  readonly id: string;
  readonly label: string;
  readonly action_type: 'uri' | 'postback';
  readonly url: string | null;
  readonly postback_data: string | null;
  readonly sort_order: number;
}

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
  /** REQ-PKG8-006: 回答の下に出すフォローアップ案内 (任意)。 */
  readonly follow_up: string | null;
  /** REQ-PKG8-008: 回答 Bubble の footer に出すリンクボタン群 (sort_order asc)。 */
  readonly links: FaqLinkRow[];
}

const FAQ_LINK_COLUMNS = 'id,label,action_type,url,postback_data,sort_order';

// PostgREST の embed (faq_links(*)) は default でテーブル名のキー (faq_links) になるため、
// FaqRow.links に対応させるため `links:faq_links(...)` で alias 化。
const FAQ_COLUMNS =
  `id,tenant_id,question,answer,category,tags,sort_order,archived,view_count,helpful_count,unhelpful_count,follow_up,links:faq_links(${FAQ_LINK_COLUMNS})`;

/**
 * PostgREST の embed (`faq_links(...)`) は埋め込み行の order を別パラメータ
 * (`faq_links.order`) で指定する必要があるが、共通 supabaseSelect は単一 order のみ
 * 対応。件数が少ない (1 FAQ あたり最大数件) ため、取得後に JS で sort_order 昇順に
 * 安定ソートして正規化する。links が未定義 (embed 失敗時) は空配列にフォールバック。
 */
function normalizeFaqRow(row: FaqRow): FaqRow {
  const links = Array.isArray(row.links) ? row.links : [];
  return {
    ...row,
    follow_up: row.follow_up ?? null,
    links: [...links].sort((a, b) => a.sort_order - b.sort_order),
  };
}

/**
 * active (archived=false) な FAQ を全件返す。category なしの行は末尾に並ぶ。
 * 件数は数十件規模を想定。スケールしてきたら category フィルタを追加する。
 */
export async function listActiveFaqs(env: TrycleRepoEnv): Promise<FaqRow[]> {
  const rows = await supabaseSelect<FaqRow>(
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
  return rows.map(normalizeFaqRow);
}

/**
 * 閲覧数 (view_count) 上位 N 件の active FAQ を返す (人気トップ表示用)。
 * 同数の場合は sort_order 昇順で安定化。
 */
export async function listTopViewedFaqs(
  env: TrycleRepoEnv,
  limit: number = 3,
): Promise<FaqRow[]> {
  const rows = await supabaseSelect<FaqRow>(
    env,
    'faqs',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      archived: `eq.false`,
    },
    {
      select: FAQ_COLUMNS,
      order: 'view_count.desc,sort_order.asc',
      limit,
    },
  );
  return rows.map(normalizeFaqRow);
}

/**
 * active FAQ から unique category を返す。null/空は除外。
 * 並び順は listActiveFaqs (sort_order asc) の登場順を保持
 * → dashboard でのカテゴリ並び替えがそのまま反映される。
 */
export async function listFaqCategories(env: TrycleRepoEnv): Promise<string[]> {
  const faqs = await listActiveFaqs(env);
  const seen = new Set<string>();
  for (const f of faqs) {
    if (f.category && f.category.trim() !== '') seen.add(f.category);
  }
  return Array.from(seen);
}

/**
 * テキスト自由入力に対する FAQ 検索。
 * question / answer / tags_text の ilike (case-insensitive partial match)。
 *
 * tags_text は migration 0017 で追加した tags 配列を空白区切りで連結した
 * 派生列 (trigger で自動同期)。「バラ」→ tags=["バラカン"] のような
 * 部分一致を可能にする。詳細は dashboard PWA migration 参照。
 *
 * 並び順: view_count desc, sort_order asc (人気と並び順両方を考慮)。
 */
export async function searchFaqs(
  env: TrycleRepoEnv,
  query: string,
  limit: number = 5,
): Promise<FaqRow[]> {
  const q = query.trim();
  if (q.length === 0) return [];
  const pattern = `*${q}*`;
  const orFilter = `(question.ilike.${pattern},answer.ilike.${pattern},tags_text.ilike.${pattern})`;
  const rows = await supabaseSelect<FaqRow>(
    env,
    'faqs',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      archived: `eq.false`,
      or: orFilter,
    },
    {
      select: FAQ_COLUMNS,
      order: 'view_count.desc,sort_order.asc',
      limit,
    },
  );
  return rows.map(normalizeFaqRow);
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
  const row = rows[0];
  return row ? normalizeFaqRow(row) : null;
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
