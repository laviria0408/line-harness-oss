/**
 * TRYCLE Pkg1「お悩み」工賃 DB マッチング (A1・Phase 4 v1.6)。
 *
 * 顧客の自由文 (「ブレーキが効かない」等) を labor_master の name / description / tags に
 * 突き合わせ、上位 3 件の作業メニュー候補を返す。設計は pg_trgm の similarity() による
 * trigram マッチだが、worker の Supabase REST helper には RPC が無く、新 Postgres 関数も
 * deploy していない。labor_master は tenant あたり ~111 行と小さく、既に 5 分 cache で
 * 全件メモリ常駐するため、**trigram similarity を TS で計算** する (KISS・テスト容易・
 * DB 往復ゼロ・Postgres pg_trgm と同じ「3-gram の Jaccard 類似」セマンティクス)。
 *
 * - name / description / tags(連結) の 3 フィールドそれぞれと similarity を取り、
 *   最大値をその行のスコアにする (Postgres GREATEST(...) と同じ)。
 * - 閾値 0.1 を超える行を score 降順で上位 3 件返す (subagent B 推奨案準拠)。
 *
 * 設計: Pkg1 v1.6 (page 386050ad6a7e81f8b701cd52c9201af6)。
 */
import type { TrycleRepoEnv } from './trycle-repo.js';
import { loadAllLabor, type LaborRow } from './trycle-pkg1-repo.js';

/** マッチ閾値 (subagent B 推奨案)。これ未満の行は候補にしない。 */
export const OSAYAMI_MATCH_THRESHOLD = 0.1;
/** 提示する候補件数の上限 (Flex carousel・推奨案)。 */
export const OSAYAMI_TOP_N = 3;

export interface LaborMatch {
  readonly labor: LaborRow;
  /** 0〜1 の trigram 類似スコア (降順で並ぶ)。 */
  readonly score: number;
}

/**
 * Postgres pg_trgm の show_trgm() に倣って文字列を 3-gram 集合へ変換する。
 *
 * pg_trgm は (1) 英数字以外を空白に正規化し小文字化 (2) 各語を「  word 」のように
 * 前 2 空白・後 1 空白でパディングしてから 3-gram を取る。日本語は語境界が無いため
 * pg_trgm の word 分割はほぼ効かないが、似た部分文字列ほど共有 3-gram が増える
 * 性質は保たれる (顧客の口語と工賃名/タグの突き合わせには十分)。完全一致の
 * Postgres 互換は狙わず「近いものほど高スコア」の順序性だけを担保する。
 */
export function trigrams(input: string): Set<string> {
  const normalized = normalizeForTrgm(input);
  const grams = new Set<string>();
  // 語ごとに前 2・後 1 空白でパディングして 3-gram を取る (pg_trgm 準拠)。
  for (const word of normalized.split(' ')) {
    if (word === '') continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) {
      grams.add(padded.slice(i, i + 3));
    }
  }
  return grams;
}

/** 英字以外 (記号等) を空白へ・連続空白を 1 つへ・小文字化・両端 trim。 */
function normalizeForTrgm(input: string): string {
  return input
    .toLowerCase()
    // ASCII 記号は空白へ (日本語/全角はそのまま 3-gram の素材にする)。
    .replace(/[!-/:-@[-`{-~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 2 文字列の trigram 類似度 (Jaccard: |A∩B| / |A∪B|)。pg_trgm similarity() と同義。
 * 空集合同士・どちらか空なら 0。
 */
export function similarity(a: string, b: string): number {
  const ga = trigrams(a);
  const gb = trigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let intersection = 0;
  for (const g of ga) {
    if (gb.has(g)) intersection += 1;
  }
  const union = ga.size + gb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** labor 1 行のスコア = name / description / tags(連結) との similarity の最大値。 */
export function scoreLabor(query: string, labor: LaborRow): number {
  const tagsJoined = labor.tags.join(' ');
  return Math.max(
    similarity(query, labor.name),
    labor.description ? similarity(query, labor.description) : 0,
    tagsJoined ? similarity(query, tagsJoined) : 0,
  );
}

/**
 * labor_master を読み込み、query に対する上位 N 件 (閾値超過) を score 降順で返す。
 * 0 件なら空配列 (呼び出し側でスタッフ相談へ倒す)。
 */
export async function searchLaborByOsayami(
  env: TrycleRepoEnv,
  query: string,
  options?: { threshold?: number; topN?: number },
): Promise<LaborMatch[]> {
  const trimmed = query.trim();
  if (trimmed === '') return [];
  const threshold = options?.threshold ?? OSAYAMI_MATCH_THRESHOLD;
  const topN = options?.topN ?? OSAYAMI_TOP_N;

  const labors = await loadAllLabor(env);
  return rankLabor(trimmed, labors, threshold, topN);
}

/**
 * 純関数版 (テスト用・DB 不要)。labor 配列を query でスコアリングし上位 N 件返す。
 * 同スコアは labor の元順序 (sort_order) を維持する (stable sort)。
 */
export function rankLabor(
  query: string,
  labors: ReadonlyArray<LaborRow>,
  threshold: number = OSAYAMI_MATCH_THRESHOLD,
  topN: number = OSAYAMI_TOP_N,
): LaborMatch[] {
  const scored = labors
    .map((labor, index) => ({ labor, score: scoreLabor(query, labor), index }))
    .filter((m) => m.score >= threshold)
    .sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
    .slice(0, topN);
  return scored.map(({ labor, score }) => ({ labor, score }));
}
