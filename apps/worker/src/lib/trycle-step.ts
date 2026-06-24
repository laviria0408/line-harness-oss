/**
 * TRYCLE Flex の Step ID 流入制御 (state machine 遷移ガード) の純関数 helper。
 *
 * 背景 (2026-06-24 真因): LINE Flex の postback は「過去に送った Flex のボタン」も
 * いつでも押せてしまう。これにより
 *   ① 連打     … 同じ確認ボタンを 2 回タップ → handler が 2 回走り case が 2 件
 *   ② 古ボタン … 数手前の Flex を遡って押す → 進んだ session に対して逆走/再起動
 *   ③ 再発行   … 30 秒後に古い選択肢を押す → 完了済みフローが甦る
 * が起きる。前回までは経路ごとに個別の冪等化 (claim / done マーカー) で潰してきたが、
 * 経路が増えるたびに穴が空く。そこで「いま session が待っている step」を Flex の
 * postback data に **step ID** として埋め込み、受信時に session 側の current/previous
 * step と突き合わせて流入を一括制御する。
 *
 * 判定 (evaluateStep):
 *   - received === current   → 'advance'  … 今の step のボタン。通常処理を進める。
 *   - received === previous  → 'rollback' … 1 つ前の step のボタン。直前 step へ戻す。
 *   - それ以外 / step 無し    → 'stale'    … 古い or 未来 or 不明。完全 silent。
 *
 * current が null (= session 無し / 完了済み) のときは received が何であれ 'stale'。
 * これにより「session が消えたあとのボタン押下」は一律 silent になる。
 *
 * この helper は state を持たない純関数。session 取得・更新・reply は呼び出し側。
 */

const STEP_PARAM = 'step';

/**
 * postback の data 文字列に `&step=<step>` を付与する。
 *
 * 既に `step=` を含む場合は値だけ付け替える (重複防止)。data が
 * `action=pkg1_region&value=brake` のような query 形式でも、素の
 * `pkg1_start` のようなトークンでも安全に扱う。
 *
 * 注意: `URLSearchParams(data).toString()` は素のトークン `faq_start` を
 * `faq_start=` に変えてしまい、`data === 'faq_start'` の厳密一致チェックを壊す
 * (pkg8 入口)。そこで round-trip せず文字列連結で付与し、既存 token を不変に保つ。
 */
export function appendStepToData(data: string, step: string): string {
  if (!step) return data;
  const stripped = stripStep(data);
  return `${stripped}&${STEP_PARAM}=${step}`;
}

/** data から既存の `step=...` セグメントを取り除く (重複付与の防止)。 */
function stripStep(data: string): string {
  if (!data.includes(`${STEP_PARAM}=`)) return data;
  const cleaned = data
    .split('&')
    .filter((seg) => !seg.startsWith(`${STEP_PARAM}=`))
    .join('&');
  return cleaned;
}

/**
 * postback の data 文字列から step ID を取り出す。無ければ null。
 *
 * 古い (step を埋めていない) Flex のボタンは null を返すため、呼び出し側は
 * これを「step 不明」として stale 判定に倒せる (後方互換)。
 */
export function parseStep(data: string): string | null {
  if (!data.includes(`${STEP_PARAM}=`)) return null;
  const value = new URLSearchParams(data).get(STEP_PARAM);
  return value && value.length > 0 ? value : null;
}

/**
 * LINE message 配列 (Flex 含む) を走査し、すべての `action.type === 'postback'` の
 * `data` に step ID を埋め込んだ **新しい配列** を返す (immutable・元は破壊しない)。
 *
 * Flex builder は純関数で session step を知らないため、dispatcher が「この reply の
 * あと session が待つ step」を後付けで全 postback に注入する単一地点。tap row /
 * carousel / footer button いずれの postback も再帰的に拾う。uri action や step を
 * 持てない他の action は素通しする。
 *
 * step が空なら元配列をそのまま返す (no-op)。
 */
export function injectStepIntoMessages<T>(messages: ReadonlyArray<T>, step: string): T[] {
  if (!step) return messages.slice();
  return messages.map((m) => injectStepDeep(m, step) as T);
}

function injectStepDeep(value: unknown, step: string): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => injectStepDeep(v, step));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const obj = value as Record<string, unknown>;
  // postback action は { type: 'postback', data: '...' }。data へ step を注入する。
  if (obj.type === 'postback' && typeof obj.data === 'string') {
    return { ...obj, data: appendStepToData(obj.data, step) };
  }
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    next[k] = injectStepDeep(v, step);
  }
  return next;
}

export type StepDecision = 'advance' | 'rollback' | 'stale';

/**
 * 受信 step と session の current / previous step を突き合わせ、流入を判定する。
 *
 * @param received  受信 postback から取り出した step (null = step 不明 = 古い Flex)
 * @param current   session が今待っている step (null = session 無し / 完了済み)
 * @param previous  1 つ前の step (null = 戻り先なし)
 */
export function evaluateStep(
  received: string | null,
  current: string | null,
  previous: string | null,
): StepDecision {
  // step が読めない (古い Flex) / session が無い → 一律 stale (silent)。
  if (!received || !current) return 'stale';
  if (received === current) return 'advance';
  if (previous && received === previous) return 'rollback';
  return 'stale';
}
