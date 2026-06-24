/**
 * TRYCLE Pkg1「お悩み」マッチングフロー (A1・Phase 4 v1.6) の純ロジック。
 *
 * 旧 escalate トリガー (dispatch 包括/不明・region/symptom/variant の sample=null) を
 * 受けて「お悩みを教えてください」自由文入力 → 工賃 DB trigram マッチ → 上位 3 件提示 →
 * [このメニューで / もう一度質問する(残N) / スタッフに相談] のループに置き換える。
 *
 * 設計上の分離: I/O (session R/W・reply・staff 通知) は呼び出し側 (trycle-pkg1.ts) が
 * 持ち、このモジュールは「次に何をすべきか」を **OsayamiOutcome として返す純関数** に
 * する。これにより loop 上限/0 件/閾値などの分岐をテスト容易に保つ (DB・LINE 不要)。
 *
 * 設計: Pkg1 v1.6 (page 386050ad6a7e81f8b701cd52c9201af6)。
 */
import { OSAYAMI_MAX_LOOPS } from './trycle-session.js';
import type { LaborMatch } from './trycle-labor-search.js';
import type { LaborRow } from './trycle-pkg1-repo.js';

/**
 * お悩み 1 ターン (自由文 → マッチ) の結果が、フローをどこへ進めるかの判定。
 *   - 'present'      : 候補ありで提示する (matches を carousel + 操作 3 択へ)
 *   - 'staff_no_match': 0 件で staff 相談へ倒す (このターンの query を引き継ぐ)
 *   - 'staff_max'    : 上限到達で staff 相談へ自動移行する
 */
export type OsayamiTurnKind = 'present' | 'staff_no_match' | 'staff_max';

export interface OsayamiTurnResult {
  readonly kind: OsayamiTurnKind;
  /** present のときの提示候補 (上位 3 件)。 */
  readonly matches: ReadonlyArray<LaborMatch>;
  /** 確定後にこのターンで使った loop 回数 (session に保存する)。 */
  readonly nextLoopCount: number;
  /** present のときの残回数 (もう一度質問できる回数)。0 なら「もう一度」を出さない。 */
  readonly remainingLoops: number;
}

/**
 * お悩み 1 ターンを評価する。`prevLoopCount` は今回の入力**前**までに使った回数。
 *
 * 流れ:
 *   1. この入力で 1 回消費 → used = prevLoopCount + 1
 *   2. used > MAX        → これ以上は自動回答不可 → staff_max (提示しない)
 *   3. matches 0 件       → staff_no_match (このターンは消費済みだが staff へ)
 *   4. matches あり       → present。残回数 = MAX - used
 */
export function evaluateOsayamiTurn(
  prevLoopCount: number,
  matches: ReadonlyArray<LaborMatch>,
  maxLoops: number = OSAYAMI_MAX_LOOPS,
): OsayamiTurnResult {
  const used = Math.max(0, prevLoopCount) + 1;

  // 上限を超えた質問 (= MAX 回使い切ったあとのもう 1 回) は自動回答を打ち切る。
  if (used > maxLoops) {
    return { kind: 'staff_max', matches: [], nextLoopCount: maxLoops, remainingLoops: 0 };
  }

  if (matches.length === 0) {
    return { kind: 'staff_no_match', matches: [], nextLoopCount: used, remainingLoops: Math.max(0, maxLoops - used) };
  }

  return {
    kind: 'present',
    matches: matches.slice(0, 3),
    nextLoopCount: used,
    remainingLoops: Math.max(0, maxLoops - used),
  };
}

/**
 * 「もう一度質問する」を押せるか (= まだ MAX に達していない)。
 * present の remainingLoops > 0 と同義だが、result 画面の再入力判定に使う。
 */
export function canAskAgain(loopCount: number, maxLoops: number = OSAYAMI_MAX_LOOPS): boolean {
  return Math.max(0, loopCount) < maxLoops;
}

/** 提示候補の labor を「osayamiCandidates」(code 配列) に落とす (session 保存用)。 */
export function candidateCodes(matches: ReadonlyArray<LaborMatch>): string[] {
  return matches.map((m) => m.labor.code);
}

/** index と保存済み候補 code 配列から labor row を引く matcher (呼び出し側で labor 解決)。 */
export function pickCandidateCode(
  candidates: ReadonlyArray<string> | undefined,
  index: number,
): string | null {
  if (!candidates || index < 0 || index >= candidates.length) return null;
  return candidates[index] ?? null;
}

/** match の labor を view 用に最小整形 (note は description 抜粋・長すぎ防止)。 */
export function matchNote(labor: LaborRow, maxLen = 60): string | null {
  const src = labor.description ?? labor.notes;
  if (!src) return null;
  return src.length > maxLen ? `${src.slice(0, maxLen - 1)}…` : src;
}
