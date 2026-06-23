/**
 * TRYCLE 案件「最近のやりとり」(chat_summary) フロー単位 append helper。
 *
 * 設計: memory `project_trycle_conversation_history_spec` v1.4 (2026-06-23)。
 *
 * データフォーマット (1 行 1 イベント・改行区切り):
 *   {HH:mm} [{flow_type}#{flow_id}] {speaker}「{text}」
 *   例: 14:30 [pkg1#0622-1430] 顧客「整備見積を依頼」
 *
 * - flow_type: 'pkg1' / 'pkg8' / 'inquiry' / 'request'
 * - flow_id:   {MMDD-HHMM} (フロー開始時刻・同一フローの全イベントで共有)
 * - speaker:   '顧客' / 'bot' / 'スタッフ'
 *
 * ## 案件 (cases) 行が無い間の扱い (重要)
 * Pkg1 のメニュー選択・Pkg8 FAQ・スタッフ送り等は **cases 行ができる前** に
 * 発生する (cases は saveQuote でのみ生成される)。そこで append は
 * **必ずアクティブフロー単位のバッファ** を介す:
 *   1. bot_sessions(kind='chat_summary') にフロー単位のバッファ state を持つ
 *      (flow_id を 1 度だけ採番し後続イベントで共有・flowType・lines・caseId)。
 *   2. cases 行が無い間 (buffer.caseId 未設定) は lines に溜める。
 *   3. このフローの saveQuote が cases 行を作った瞬間に flushChatSummaryBuffer で
 *      lines を **その新 case** へ移し、buffer.caseId にその case を記録する。
 *   4. flush 後の同フロー append (見積成立・来店予定など) は buffer.caseId が
 *      指す **このフローの case** へ直接 append する。
 *
 * ## 「古い case を選ぶ」罠の回避 (2026-06-23 真因 1/2)
 * 旧実装は「line_user_id の直近 case (created_at desc)」へ直接 append していた。
 * 同一ユーザーが連続して 2 回フローを回すと、2 回目のイベントが 1 回目の古い case
 * に流れ込み、2 回目の saveQuote が作る新 case にはフロー本文が残らない
 * (= 同 flow_id が 2 case に分散)。本実装は **アクティブフローの buffer.caseId のみ**
 * を append 先にし、findRecentCase フォールバックを廃止することでこれを防ぐ。
 */
import {
  supabaseSelect,
  supabaseUpdate,
  supabaseUpsert,
} from './supabase.js';
import { getTenantId, type TrycleRepoEnv } from './trycle-repo.js';

/** chat_summary バッファを保持する bot_sessions の kind。 */
export const CHAT_SUMMARY_KIND = 'chat_summary';

/** 上限: これを超えたら古い行から間引く (LINE 長文化・列肥大の防止)。 */
export const MAX_SUMMARY_LINES = 300;
export const MAX_SUMMARY_CHARS = 50_000;

export type FlowType = 'pkg1' | 'pkg8' | 'inquiry' | 'request';
export type Speaker = '顧客' | 'bot' | 'スタッフ';

export interface ChatSummaryEvent {
  readonly flowType: FlowType;
  readonly speaker: Speaker;
  readonly text: string;
  /** 表示時刻 (省略時は now)。テスト用に注入可能。 */
  readonly at?: Date;
  /**
   * フロー開始イベント (起票) に true を渡すと、必ず新しい flow_id を採番する。
   * これにより、同一ユーザーが既存案件を持ったまま新しいフローを始めても、
   * 直前フローの flow_id を引き継いで同じカードに混ざるのを防ぐ。
   */
  readonly startNewFlow?: boolean;
}

interface ChatSummaryBufferState {
  /** {MMDD-HHMM} 形式。フロー開始時に 1 度だけ採番。 */
  readonly flowId: string;
  readonly flowType: FlowType;
  /** 既に整形済みの 1 行イベント (改行なし)。case へ flush 済なら空。 */
  readonly lines: string[];
  /**
   * このフローの saveQuote が作った case の id。flush 後に設定する。
   * 設定済 = 「このフロー専用の case」が確定したので、以降の同フロー append は
   * findRecentCase でなく **この caseId** へ直接 append する (古い case 混入を防ぐ)。
   */
  readonly caseId?: string;
}

// ── format helpers ────────────────────────────────────────────────────────────

/** Date → JST 壁時計の 2 桁時刻文字列を {h, m} で返す。 */
function jstParts(at: Date): { mm2: number; dd2: number; hh: string; min: string } {
  // toISOString は UTC。JST 表示にするため +9h して UTC フィールドを読む。
  const jst = new Date(at.getTime() + 9 * 60 * 60 * 1000);
  return {
    mm2: jst.getUTCMonth() + 1,
    dd2: jst.getUTCDate(),
    hh: String(jst.getUTCHours()).padStart(2, '0'),
    min: String(jst.getUTCMinutes()).padStart(2, '0'),
  };
}

/** {MMDD-HHMM} 形式の flow_id を JST で採番する。 */
export function makeFlowId(at: Date = new Date()): string {
  const p = jstParts(at);
  return `${String(p.mm2).padStart(2, '0')}${String(p.dd2).padStart(2, '0')}-${p.hh}${p.min}`;
}

/** 「14:30」形式の表示時刻 (JST)。 */
function formatTime(at: Date): string {
  const p = jstParts(at);
  return `${p.hh}:${p.min}`;
}

/** text の改行・鉤括弧をサニタイズ (1 行 1 イベント不変条件を守る)。 */
function sanitizeText(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[「」]/g, '').trim();
}

/**
 * 1 イベント = 1 行を整形する。
 *   {HH:mm} [{flow_type}#{flow_id}] {speaker}「{text}」
 */
export function formatChatSummaryLine(
  event: ChatSummaryEvent,
  flowId: string,
): string {
  const at = event.at ?? new Date();
  return `${formatTime(at)} [${event.flowType}#${flowId}] ${event.speaker}「${sanitizeText(event.text)}」`;
}

/**
 * 既存サマリー本文に新しい行 (1 行 or 改行入り複数行) を足し、上限を超えたら
 * 古い行 (先頭) から間引く。純関数 (テスト容易)。
 */
export function appendLineWithCap(existing: string | null, line: string): string {
  const prev = (existing ?? '').split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const added = line.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const lines = [...prev, ...added];
  // 行数上限
  let capped = lines.length > MAX_SUMMARY_LINES
    ? lines.slice(lines.length - MAX_SUMMARY_LINES)
    : lines;
  // 文字数上限 (古い行から落とす)
  let joined = capped.join('\n');
  while (joined.length > MAX_SUMMARY_CHARS && capped.length > 1) {
    capped = capped.slice(1);
    joined = capped.join('\n');
  }
  return joined;
}

// ── case lookup ───────────────────────────────────────────────────────────────

/** line_user_id の直近 cases 行 (id + chat_summary) を返す。無ければ null。 */
async function findRecentCase(
  env: TrycleRepoEnv,
  lineUserId: string,
): Promise<{ id: string; chat_summary: string | null } | null> {
  const rows = await supabaseSelect<{ id: string; chat_summary: string | null }>(
    env,
    'cases',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      line_user_id: `eq.${lineUserId}`,
    },
    { select: 'id,chat_summary', order: 'created_at.desc', limit: 1 },
  );
  return rows[0] ?? null;
}

// ── buffer (bot_sessions kind='chat_summary') ─────────────────────────────────

async function getBuffer(
  env: TrycleRepoEnv,
  lineUserId: string,
): Promise<ChatSummaryBufferState | null> {
  const rows = await supabaseSelect<{ state: Partial<ChatSummaryBufferState> }>(
    env,
    'bot_sessions',
    {
      tenant_id: `eq.${getTenantId(env)}`,
      line_user_id: `eq.${lineUserId}`,
      kind: `eq.${CHAT_SUMMARY_KIND}`,
    },
    { select: 'state', limit: 1 },
  );
  const state = rows[0]?.state;
  if (!state || typeof state.flowId !== 'string' || !Array.isArray(state.lines)) {
    return null;
  }
  return {
    flowId: state.flowId,
    flowType: (state.flowType as FlowType) ?? 'pkg1',
    lines: state.lines,
    ...(typeof state.caseId === 'string' ? { caseId: state.caseId } : {}),
  };
}

async function setBuffer(
  env: TrycleRepoEnv,
  lineUserId: string,
  state: ChatSummaryBufferState,
): Promise<void> {
  await supabaseUpsert(
    env,
    'bot_sessions',
    [
      {
        tenant_id: getTenantId(env),
        line_user_id: lineUserId,
        kind: CHAT_SUMMARY_KIND,
        state,
        updated_at: new Date().toISOString(),
      },
    ],
    { onConflict: 'tenant_id,line_user_id,kind' },
  );
}

// buffer は flow 切替時に setBuffer (upsert) で丸ごと置換されるため delete は不要
// (新フローは startNewFlow で caseId 無しの fresh buffer に上書きされる)。

// ── public API ────────────────────────────────────────────────────────────────

/**
 * 1 イベントを「最近のやりとり」へ append する。
 *
 * 紐付け先の決定 (上から優先):
 *   1. **アクティブフローの buffer.caseId** が確定済 (= このフローの saveQuote が
 *      既に case を作った) → その case へ直接 append。
 *   2. アクティブフローの buffer がある (まだ case 未確定) → buffer.lines へ溜める。
 *   3. buffer が無い & このイベントが新フローでない → 直近 case があればそこへ
 *      append (consent callback の「同意書を提出」など・フロー外の後追いイベント)。
 *   4. それも無ければ新規 buffer を作る。
 *
 * flow_id は同一フロー内で共有する: バッファの flowId を再利用し、無ければ採番する。
 * **重要**: アクティブフロー (buffer あり) のときは findRecentCase を一切見ない。
 * 直近 case が前フローの古い case のことがあり、混ぜると同 flow_id が複数 case に
 * 分散する (2026-06-23 真因 1/2)。失敗はフローを止めない (best-effort)。
 */
export async function appendChatSummary(
  env: TrycleRepoEnv,
  lineUserId: string,
  event: ChatSummaryEvent,
): Promise<void> {
  try {
    const at = event.at ?? new Date();
    const buffer = await getBuffer(env, lineUserId);
    // 同フロー継続なら buffer の flow_id を再利用。新フロー開始 or 別フロー種別なら採番。
    const reuse = !event.startNewFlow && buffer?.flowType === event.flowType;
    const flowId = reuse ? buffer!.flowId : makeFlowId(at);
    const line = formatChatSummaryLine(event, flowId);

    // (1) アクティブフローの case が確定済 → その case へ直接 append (古い case 混入なし)。
    if (reuse && buffer!.caseId) {
      await appendToCase(env, buffer!.caseId, line);
      // buffer は維持 (caseId/flowId/flowType をそのまま・lines は引き続き空)。
      await setBuffer(env, lineUserId, {
        flowId,
        flowType: event.flowType,
        lines: [],
        caseId: buffer!.caseId,
      });
      return;
    }

    // (2) アクティブフロー継続中だがまだ case 未確定 → buffer.lines に溜める。
    if (reuse) {
      const joined = appendLineWithCap(buffer!.lines.join('\n') || null, line);
      await setBuffer(env, lineUserId, {
        flowId,
        flowType: event.flowType,
        lines: joined.split('\n'),
      });
      return;
    }

    // ここから先は「アクティブフロー外」(buffer 無し or 別フロー種別 or 新フロー開始)。
    // (3) 新フロー開始でなく、直近 case があるならフロー外の後追いイベントとして
    //     その case へ append する (consent callback 等)。新フロー開始 (startNewFlow)
    //     のイベントは必ず buffer へ → 自フローの case へ flush させる。
    if (!event.startNewFlow) {
      const recentCase = await findRecentCase(env, lineUserId);
      if (recentCase) {
        const next = appendLineWithCap(recentCase.chat_summary, line);
        await supabaseUpdate(
          env,
          'cases',
          { id: `eq.${recentCase.id}`, tenant_id: `eq.${getTenantId(env)}` },
          { chat_summary: next, updated_at: new Date().toISOString() },
        );
        return;
      }
    }

    // (4) 新規 buffer を作る (case 生成時に flush)。
    await setBuffer(env, lineUserId, {
      flowId,
      flowType: event.flowType,
      lines: [line],
    });
  } catch (err) {
    console.error('[trycle-chat-summary] appendChatSummary failed', err);
  }
}

/** case.chat_summary に 1 行 append する (read-modify-write・上限 cap)。 */
async function appendToCase(
  env: TrycleRepoEnv,
  caseId: string,
  line: string,
): Promise<void> {
  const rows = await supabaseSelect<{ chat_summary: string | null }>(
    env,
    'cases',
    { id: `eq.${caseId}`, tenant_id: `eq.${getTenantId(env)}` },
    { select: 'chat_summary', limit: 1 },
  );
  const next = appendLineWithCap(rows[0]?.chat_summary ?? null, line);
  await supabaseUpdate(
    env,
    'cases',
    { id: `eq.${caseId}`, tenant_id: `eq.${getTenantId(env)}` },
    { chat_summary: next, updated_at: new Date().toISOString() },
  );
}

/**
 * このフローの cases 行が新規作成された直後に呼ぶ。バッファに溜まっていた
 * イベント行を **その新 case** の chat_summary へ移す。
 *
 * - saveQuote は chat_summary を入れずに case を作る (legacy 固定文言は廃止・真因 3)
 *   ため、case の既存 chat_summary (通常 null) にバッファ行を append する。
 * - **buffer.caseId にこの caseId を記録**し、flush 後に来る同フローの append
 *   (見積成立・来店予定・スタッフ引継など) が findRecentCase でなく
 *   **この case** へ直接 append できるようにする (古い case 混入の防止・真因 1/2)。
 *
 * バッファが無い場合でも、後続の同フロー append が caseId を引けるよう buffer を
 * 作って caseId を記録する (flowType/flowId は不明なら既定値・後続 append が
 * startNewFlow せず continue する想定)。失敗はフローを止めない。
 */
export async function flushChatSummaryBuffer(
  env: TrycleRepoEnv,
  lineUserId: string,
  caseId: string,
): Promise<void> {
  try {
    const buffer = await getBuffer(env, lineUserId);
    if (buffer && buffer.lines.length > 0) {
      await appendToCase(env, caseId, buffer.lines.join('\n'));
    }
    // バッファ行は case へ移した。**flowId/flowType を保持しつつ caseId を記録**して
    // 同フローの後続 append が新 case へ直接届くようにする (lines は空)。
    await setBuffer(env, lineUserId, {
      flowId: buffer?.flowId ?? makeFlowId(),
      flowType: buffer?.flowType ?? 'pkg1',
      lines: [],
      caseId,
    });
  } catch (err) {
    console.error('[trycle-chat-summary] flushChatSummaryBuffer failed', err);
  }
}
