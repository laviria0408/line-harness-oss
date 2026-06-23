/**
 * trycle-chat-summary の case 紐付けロジック統合テスト (2026-06-23 真因 1/2)。
 *
 * 検証する不変条件:
 *   - 同一フローの全イベント (起票〜見積成立) が **このフローの 1 case** に集約される。
 *   - 同一ユーザーが 2 回連続でフローを回しても、2 回目のイベントが 1 回目の
 *     古い case に混ざらない (= 同 flow_id が複数 case に分散しない)。
 *   - flush 後の同フロー append が新 case へ直接届く。
 *
 * Supabase REST は globalThis.fetch をステートフルな偽実装で差し替えて再現する
 * (bot_sessions=buffer / cases=chat_summary)。他テスト (trycle-pkg1-repo.test.ts) と
 * 同じ fetch スタブ方式。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  appendChatSummary,
  flushChatSummaryBuffer,
} from './trycle-chat-summary.js';
import type { TrycleRepoEnv } from './trycle-repo.js';

function env(): TrycleRepoEnv {
  return {
    SUPABASE_URL: 'https://sb.example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
    TRYCLE_TENANT_ID: 't-1',
  } as TrycleRepoEnv;
}

const USER = 'U_test_taro';

/** 偽 Supabase: cases / bot_sessions を in-memory で再現する fetch スタブ。 */
interface FakeCase {
  id: string;
  line_user_id: string;
  chat_summary: string | null;
  created_at: string;
}

function installFakeSupabase() {
  const cases: FakeCase[] = [];
  // bot_sessions chat_summary buffer は (user) で 1 行。state を保持。
  let bufferState: Record<string, unknown> | null = null;
  let seq = 0;

  function parseFilters(url: URL): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) {
      if (['select', 'limit', 'order', 'on_conflict'].includes(k)) continue;
      out[k] = v;
    }
    return out;
  }

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const table = decodeURIComponent(url.pathname.split('/rest/v1/')[1] ?? '');
    const filters = parseFilters(url);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (table === 'cases') {
      if (method === 'GET') {
        let rows = cases.filter((cs) => {
          if (filters.line_user_id && filters.line_user_id !== `eq.${cs.line_user_id}`) return false;
          if (filters.id && filters.id !== `eq.${cs.id}`) return false;
          return true;
        });
        // order=created_at.desc サポート (findRecentCase 用)。
        if (url.searchParams.get('order')?.startsWith('created_at.desc')) {
          rows = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
        }
        const limit = Number(url.searchParams.get('limit') ?? '1');
        return json(rows.slice(0, limit).map((r) => ({ id: r.id, chat_summary: r.chat_summary })));
      }
      if (method === 'PATCH') {
        const patch = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        for (const cs of cases) {
          if (filters.id && filters.id === `eq.${cs.id}`) {
            if ('chat_summary' in patch) cs.chat_summary = patch.chat_summary as string | null;
          }
        }
        return json(null);
      }
    }

    if (table === 'bot_sessions') {
      if (method === 'GET') {
        return json(bufferState ? [{ state: bufferState }] : []);
      }
      if (method === 'POST') {
        // upsert (merge-duplicates) — buffer は user×kind で 1 行なので state を置換。
        const rows = JSON.parse(String(init?.body ?? '[]')) as Array<Record<string, unknown>>;
        bufferState = (rows[0]?.state as Record<string, unknown>) ?? null;
        return json(null, 201);
      }
      if (method === 'DELETE') {
        bufferState = null;
        return json(null);
      }
    }

    return json([], 200);
  };

  vi.stubGlobal('fetch', vi.fn(fetchImpl));

  return {
    /** saveQuote 相当: 新 case を作って返す。 */
    createCase(): FakeCase {
      const cs: FakeCase = {
        id: `case-${++seq}`,
        line_user_id: USER,
        chat_summary: null,
        created_at: new Date(Date.now() + seq * 1000).toISOString(),
      };
      cases.push(cs);
      return cs;
    },
    getCase(id: string): FakeCase | undefined {
      return cases.find((c) => c.id === id);
    },
    get cases() {
      return cases;
    },
  };
}

describe('chat_summary case 紐付け (真因 1/2)', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('単一フロー: 起票〜見積成立が 1 case に集約される', async () => {
    const db = installFakeSupabase();
    const e = env();

    // 起票 → メニュー選択 (case 前・buffer に溜まる)
    await appendChatSummary(e, USER, { flowType: 'pkg1', speaker: '顧客', text: '整備見積を依頼', startNewFlow: true });
    await appendChatSummary(e, USER, { flowType: 'pkg1', speaker: '顧客', text: 'ブレーキ調整' });
    // 見積成立 (まだ case 前)
    await appendChatSummary(e, USER, { flowType: 'pkg1', speaker: 'bot', text: '概算見積 3300' });

    // saveQuote 相当で case 生成 → flush
    const c1 = db.createCase();
    await flushChatSummaryBuffer(e, USER, c1.id);

    // flush 後の同フロー append (スタッフ引継)
    await appendChatSummary(e, USER, { flowType: 'pkg1', speaker: 'bot', text: 'スタッフ引継: 来店予定の受付' });

    const summary = db.getCase(c1.id)!.chat_summary ?? '';
    expect(summary).toContain('整備見積を依頼');
    expect(summary).toContain('ブレーキ調整');
    expect(summary).toContain('概算見積 3300');
    expect(summary).toContain('スタッフ引継');
    // 全行が同じ flow_id を共有する。
    const flowIds = new Set(
      summary.split('\n').map((l) => l.match(/\[pkg1#([^\]]+)\]/)?.[1]).filter(Boolean),
    );
    expect(flowIds.size).toBe(1);
  });

  it('連続 2 フロー: 2 回目のイベントが 1 回目の古い case に混ざらない', async () => {
    const db = installFakeSupabase();
    const e = env();
    // 実機の 11:01 / 11:20 と同じく 2 フローを別時刻にして flow_id を分ける。
    const at1101 = new Date('2026-06-23T02:01:00Z'); // 11:01 JST
    const at1120 = new Date('2026-06-23T02:20:00Z'); // 11:20 JST

    // ── 1 回目のフロー ──
    await appendChatSummary(e, USER, { flowType: 'pkg1', speaker: '顧客', text: '整備見積を依頼', startNewFlow: true, at: at1101 });
    await appendChatSummary(e, USER, { flowType: 'pkg1', speaker: '顧客', text: 'タイヤ交換', at: at1101 });
    await appendChatSummary(e, USER, { flowType: 'pkg1', speaker: 'bot', text: '概算見積 17600', at: at1101 });
    const caseA = db.createCase();
    await flushChatSummaryBuffer(e, USER, caseA.id);

    // ── 2 回目のフロー (同じユーザー・case A が既に存在) ──
    await appendChatSummary(e, USER, { flowType: 'pkg1', speaker: '顧客', text: '整備見積を依頼', startNewFlow: true, at: at1120 });
    await appendChatSummary(e, USER, { flowType: 'pkg1', speaker: '顧客', text: 'ブレーキ調整', at: at1120 });
    await appendChatSummary(e, USER, { flowType: 'pkg1', speaker: 'bot', text: '概算見積 3300', at: at1120 });
    const caseB = db.createCase();
    await flushChatSummaryBuffer(e, USER, caseB.id);
    await appendChatSummary(e, USER, { flowType: 'pkg1', speaker: 'bot', text: 'スタッフ引継: 来店予定の受付', at: at1120 });

    const summaryA = db.getCase(caseA.id)!.chat_summary ?? '';
    const summaryB = db.getCase(caseB.id)!.chat_summary ?? '';

    // case A は 1 回目のフローだけ・2 回目の内容が漏れていない。
    expect(summaryA).toContain('タイヤ交換');
    expect(summaryA).toContain('17600');
    expect(summaryA).not.toContain('ブレーキ調整');
    expect(summaryA).not.toContain('3300');
    expect(summaryA).not.toContain('スタッフ引継');

    // case B は 2 回目のフロー全部 (flush 後の append 含む)。
    expect(summaryB).toContain('ブレーキ調整');
    expect(summaryB).toContain('3300');
    expect(summaryB).toContain('スタッフ引継');
    expect(summaryB).not.toContain('タイヤ交換');

    // 各 case 内では flow_id が 1 種類・case 間で別 flow_id。
    const idsA = new Set(summaryA.split('\n').map((l) => l.match(/\[pkg1#([^\]]+)\]/)?.[1]).filter(Boolean));
    const idsB = new Set(summaryB.split('\n').map((l) => l.match(/\[pkg1#([^\]]+)\]/)?.[1]).filter(Boolean));
    expect(idsA.size).toBe(1);
    expect(idsB.size).toBe(1);
    expect([...idsA][0]).not.toBe([...idsB][0]);
  });

  it('フロー外の後追いイベント (consent) は直近 case へ付く', async () => {
    const db = installFakeSupabase();
    const e = env();
    // case を 1 つ作っておく (pdf_only 経路で flush 済・buffer は caseId 付き)。
    await appendChatSummary(e, USER, { flowType: 'pkg1', speaker: '顧客', text: '整備見積を依頼', startNewFlow: true });
    const caseA = db.createCase();
    await flushChatSummaryBuffer(e, USER, caseA.id);
    // consent callback の「同意書を提出」(startNewFlow なし) は同フロー扱いで case A へ。
    await appendChatSummary(e, USER, { flowType: 'pkg1', speaker: '顧客', text: '同意書を提出' });
    expect(db.getCase(caseA.id)!.chat_summary ?? '').toContain('同意書を提出');
  });
});
