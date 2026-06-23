/**
 * dashboard (Vercel) → bot worker の内部 API 共有認証ヘルパー。
 *
 * dashboard server だけが `BOT_INTERNAL_TOKEN` (= bot 側 `DASHBOARD_INTERNAL_TOKEN`)
 * を持ち、`Authorization: Bearer <token>` で叩く。ブラウザには token を出さない。
 * staff API key とは別系統で、authMiddleware は該当パスを bypass する。
 *
 * cases-messages (会話履歴 GET) と push-message (LINE 送信中継 POST) で共用する。
 */
import type { Context } from 'hono';
import type { Env } from '../index.js';
import { supabaseSelect } from './supabase.js';

export type DashboardAuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401 | 503; readonly error: string };

/**
 * `Authorization: Bearer <DASHBOARD_INTERNAL_TOKEN>` を検証する。
 *
 * token 未設定なら 503 (機能無効)・不一致なら 401。length 比較のみ・値は log しない。
 */
export function verifyDashboardToken(c: Context<Env>): DashboardAuthResult {
  const expected = c.env.DASHBOARD_INTERNAL_TOKEN;
  if (!expected) {
    return { ok: false, status: 503, error: 'internal token not configured' };
  }
  const header = c.req.header('Authorization');
  const token = header && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
  if (!token || token !== expected) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}

export type CaseLineLookup =
  | { readonly status: 'ok'; readonly lineUserId: string | null }
  | { readonly status: 'not_found' }
  | { readonly status: 'tenant_unconfigured' };

/**
 * caseId → cases.line_user_id を Supabase (tenant スコープ) で解決する。
 *
 * - tenant 未設定: `tenant_unconfigured`
 * - 案件が無い: `not_found`
 * - 案件はあるが LINE 未連携 (dashboard 起票): `ok` + lineUserId=null
 */
export async function resolveCaseLineUserId(c: Context<Env>, caseId: string): Promise<CaseLineLookup> {
  const tenantId = c.env.TRYCLE_TENANT_ID;
  if (!tenantId) return { status: 'tenant_unconfigured' };

  const rows = await supabaseSelect<{ line_user_id: string | null }>(
    c.env,
    'cases',
    { id: `eq.${caseId}`, tenant_id: `eq.${tenantId}` },
    { select: 'line_user_id', limit: 1 },
  );
  if (!rows[0]) return { status: 'not_found' };
  return { status: 'ok', lineUserId: rows[0].line_user_id ?? null };
}

/**
 * 会話履歴の時間範囲を取得する。
 *
 * 当 case の created_at 〜 同 line_user_id の「次 case の created_at」までの時間窓を返す。
 * messages_log は friend_id 単位で全件保存されているので、case 単位の会話タブで
 * friend_id だけで絞ると過去 case の会話も全部出てしまう (実機 bug)。
 *
 * - status='ok' + startAt + endAt(null 可・null=現在まで)
 * - status='not_found' or 'tenant_unconfigured' は resolveCaseLineUserId と同形式
 * - case に line_user_id が無い (dashboard 起票) なら null/null を返す
 */
export interface CaseConversationRange {
  status: 'ok' | 'not_found' | 'tenant_unconfigured';
  startAt?: string | null;
  endAt?: string | null;
}

export async function resolveCaseConversationRange(c: Context<Env>, caseId: string): Promise<CaseConversationRange> {
  const tenantId = c.env.TRYCLE_TENANT_ID;
  if (!tenantId) return { status: 'tenant_unconfigured' };

  // 1) 当 case の created_at + line_user_id を取る
  const cur = await supabaseSelect<{ line_user_id: string | null; created_at: string }>(
    c.env,
    'cases',
    { id: `eq.${caseId}`, tenant_id: `eq.${tenantId}` },
    { select: 'line_user_id,created_at', limit: 1 },
  );
  if (!cur[0]) return { status: 'not_found' };
  const startAt = cur[0].created_at;
  const lineUserId = cur[0].line_user_id;
  if (!lineUserId) return { status: 'ok', startAt: null, endAt: null };

  // 2) 同 line_user_id の next case (created_at > startAt) の最古を end として取る
  const next = await supabaseSelect<{ created_at: string }>(
    c.env,
    'cases',
    {
      tenant_id: `eq.${tenantId}`,
      line_user_id: `eq.${lineUserId}`,
      created_at: `gt.${startAt}`,
    },
    { select: 'created_at', order: 'created_at.asc', limit: 1 },
  );
  return { status: 'ok', startAt, endAt: next[0]?.created_at ?? null };
}
