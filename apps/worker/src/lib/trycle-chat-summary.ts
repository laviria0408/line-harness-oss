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
 * 発生する (cases は saveQuote でのみ生成される)。そこで append は:
 *   1. line_user_id の直近 cases 行があればそこへ直接 append。
 *   2. 無ければ bot_sessions(kind='chat_summary') に **バッファ** する
 *      (同時に flow_id を 1 度だけ採番し、後続イベントで共有する)。
 *   3. cases 行が生成された瞬間 (saveQuote) に flushChatSummaryBuffer で
 *      バッファ行を cases.chat_summary へ移し、バッファを消す。
 *
 * これにより「案件起票より前のメニュー選択」も最終的に案件のサマリーに残る。
 */
import {
  supabaseSelect,
  supabaseUpdate,
  supabaseUpsert,
  supabaseDelete,
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
  /** 既に整形済みの 1 行イベント (改行なし)。 */
  readonly lines: string[];
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

async function clearBuffer(env: TrycleRepoEnv, lineUserId: string): Promise<void> {
  await supabaseDelete(env, 'bot_sessions', {
    tenant_id: `eq.${getTenantId(env)}`,
    line_user_id: `eq.${lineUserId}`,
    kind: `eq.${CHAT_SUMMARY_KIND}`,
  });
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * 1 イベントを「最近のやりとり」へ append する。
 *
 * - 直近 cases 行があれば直接 cases.chat_summary に append。
 * - 無ければ bot_sessions バッファに溜める (case 生成時に flush)。
 *
 * flow_id は同一フロー内で共有する: バッファの flowId を再利用し、無ければ採番する。
 * 失敗はフローを止めない (best-effort・呼び出し側は await して catch 不要)。
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
    const recentCase = await findRecentCase(env, lineUserId);

    if (recentCase) {
      // case 行がある → 直接 append。flow_id は buffer 経由で同一フロー内共有する。
      const next = appendLineWithCap(recentCase.chat_summary, line);
      await supabaseUpdate(
        env,
        'cases',
        { id: `eq.${recentCase.id}`, tenant_id: `eq.${getTenantId(env)}` },
        { chat_summary: next, updated_at: new Date().toISOString() },
      );
      // active flow の flow_id を保持 (lines は case へ出したので空)。後続の同フロー
      // append が同じ flow_id を引けるようにする。
      await setBuffer(env, lineUserId, { flowId, flowType: event.flowType, lines: [] });
      return;
    }

    // case 行が無い → バッファに溜める (case 生成時に flush)。
    const prevLines = reuse ? buffer!.lines : [];
    const joined = appendLineWithCap(prevLines.join('\n') || null, line);
    await setBuffer(env, lineUserId, {
      flowId,
      flowType: event.flowType,
      lines: joined.split('\n'),
    });
  } catch (err) {
    console.error('[trycle-chat-summary] appendChatSummary failed', err);
  }
}

/**
 * cases 行が新規作成された直後に呼ぶ。バッファに溜まっていた行を
 * cases.chat_summary の先頭に移し、バッファを消す。
 *
 * caseInitialSummary には saveQuote が入れた既定文言が来る場合があるが、本仕様では
 * フロー単位イベント行で置き換える方が一貫するため、バッファ行 (= イベント履歴) を
 * 正としてマージする。バッファが空なら何もしない (既定文言を残す)。
 * 失敗はフローを止めない。
 */
export async function flushChatSummaryBuffer(
  env: TrycleRepoEnv,
  lineUserId: string,
  caseId: string,
): Promise<void> {
  try {
    const buffer = await getBuffer(env, lineUserId);
    if (!buffer || buffer.lines.length === 0) return;
    const joined = appendLineWithCap(null, buffer.lines.join('\n'));
    await supabaseUpdate(
      env,
      'cases',
      { id: `eq.${caseId}`, tenant_id: `eq.${getTenantId(env)}` },
      { chat_summary: joined, updated_at: new Date().toISOString() },
    );
    // バッファ行は case へ移したのでクリアするが、**flowId は保持**する。
    // flush 直後に来る同フローの append (見積成立など・case 存在経路) が同じ
    // flow_id を再利用でき、別カードへ分離するのを防ぐ (lines は空・flowType 維持)。
    await setBuffer(env, lineUserId, {
      flowId: buffer.flowId,
      flowType: buffer.flowType,
      lines: [],
    });
  } catch (err) {
    console.error('[trycle-chat-summary] flushChatSummaryBuffer failed', err);
  }
}
