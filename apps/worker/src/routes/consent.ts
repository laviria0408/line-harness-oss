/**
 * Consent (Pkg1 LIFF 案 B) HTTP routes.
 *
 * 整備同意書 LIFF (`apps/consent-liff/`) 向けの 2 endpoint:
 *   GET  /api/consent-document  … 最新の有効な同意書文面を返す (Step 1 表示用)
 *   POST /api/consent-callback  … LIFF からの同意 submit を consents へ UPSERT
 *
 * 認証 (案 B): LIFF が送る LINE access_token を LINE Profile API
 * (https://api.line.me/v2/profile) で verify し、access_token と body の
 * line_user_id が一致することを確認する。Apps Script (Google Form) 経由の
 * 既存 Phase 7-D HMAC callback とは別経路 (HMAC は LIFF からは使わない)。
 *
 * 同意は clickwrap (能動チェック) で取得し、確認画面の表示時刻
 * (confirmation_screen_shown_at) を payload に証跡保存する (電子契約法・APPI 上、
 * 同意成立と証跡を補強する)。これらの endpoint は authMiddleware の staff 認証を
 * bypass する (LIFF は staff API key を持たない) ため、access_token verify を
 * 各ハンドラで必ず行う。
 */
import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  findActiveConsentDocument,
  findCustomerIdByLineUserId,
  upsertConsent,
  upsertCustomer,
  MAINTENANCE_CONSENT_SOURCE,
} from '../lib/trycle-repo.js';
import {
  tagFriendByLineUserId,
  TRYCLE_TAG_CONSENT,
} from '../lib/trycle-tagging.js';
import {
  attachCustomerIdToAllNullCases,
} from '../lib/trycle-pkg1-repo.js';
import { resumeReservationAfterConsent } from '../lib/trycle-pkg1.js';
import { appendChatSummary } from '../lib/trycle-chat-summary.js';
import { LineClient } from '@line-crm/line-sdk';

export const consent = new Hono<Env>();

const LINE_PROFILE_API = 'https://api.line.me/v2/profile';

// ── GET /api/consent-document ────────────────────────────────────────────────

consent.get('/api/consent-document', async (c) => {
  const verified = await verifyAccessToken(c.req.header('Authorization'));
  if (!verified) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  try {
    const doc = await findActiveConsentDocument(c.env);
    if (!doc) {
      return c.json({ error: 'consent document not found' }, 404);
    }
    return c.json({
      id: doc.id,
      version: doc.version,
      title: doc.title,
      body_md: doc.body_md,
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 500);
  }
});

// ── POST /api/consent-callback ───────────────────────────────────────────────

consent.post('/api/consent-callback', async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid JSON' }, 400);
  }
  const parsed = parseCallbackBody(raw);
  if (!parsed.ok) {
    return c.json({ ok: false, error: parsed.reason }, 400);
  }

  // access_token を LINE Profile API で verify し、line_user_id と一致確認。
  // body の access_token を優先し、無ければ Authorization ヘッダを使う。
  const headerToken = bearerFromHeader(c.req.header('Authorization'));
  const accessToken = parsed.accessToken ?? headerToken;
  if (!accessToken) {
    return c.json({ ok: false, error: 'access_token is required' }, 401);
  }
  const verifiedUserId = await verifyAccessToken(`Bearer ${accessToken}`);
  if (!verifiedUserId) {
    return c.json({ ok: false, error: 'access_token verification failed' }, 401);
  }
  if (verifiedUserId !== parsed.lineUserId) {
    return c.json({ ok: false, error: 'line_user_id mismatch' }, 403);
  }

  try {
    await upsertCustomer(c.env, {
      lineUserId: parsed.lineUserId,
      name: parsed.name,
      phone: parsed.phone,
      // 任意・空文字なら null。住所・ふりがな・月間走行距離は customers 列が無いため payload のみで保持。
      email: parsed.email.length > 0 ? parsed.email : null,
    });
    const customerId = await findCustomerIdByLineUserId(c.env, parsed.lineUserId);
    await upsertConsent(c.env, {
      lineUserId: parsed.lineUserId,
      customerId,
      source: MAINTENANCE_CONSENT_SOURCE,
      payload: {
        consent_document_version: parsed.consentDocumentVersion,
        confirmation_screen_shown_at: parsed.confirmationScreenShownAt,
        name: parsed.name,
        kana: parsed.kana,
        phone: parsed.phone,
        address: parsed.address,
        email: parsed.email,
        monthly_distance: parsed.monthlyDistance,
      },
    });
    await tagFriendByLineUserId(c.env, parsed.lineUserId, TRYCLE_TAG_CONSENT);

    // 同意書取得 (直近 case があれば append・無ければバッファ)。flow は pkg1 扱い。
    await appendChatSummary(c.env, parsed.lineUserId, {
      flowType: 'pkg1',
      speaker: '顧客',
      text: '同意書を提出',
    });

    // 経路 E 拡張 (ユーザ確定仕様): 同 line_user_id で customer_id 未紐付け (null) の
    // 全 case を、今登録した customer に一括後付け紐付けする。ケース ① (PDF → 来店予約)
    // / ③ (PDF 複数 → LIFF) で過去の pdf_only case が複数 null のまま残るのを解消する。
    // 失敗しても同意取得は成立しているのでフローは止めない (best-effort)。
    if (customerId) {
      try {
        await attachCustomerIdToAllNullCases(c.env, customerId, parsed.lineUserId);
      } catch (err) {
        console.error('[consent-callback] attach customer_id to null cases failed', err);
      }
    }

    // 経路 D-2: 来店予定で未同意だった場合は cart を退避してある (pkg1_cart)。
    // 同意成立後にここから来店予定フロー (店舗選択) を Push で再開する。
    let resumedReservation = false;
    if (c.env.LINE_CHANNEL_ACCESS_TOKEN) {
      try {
        const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
        resumedReservation = await resumeReservationAfterConsent(
          c.env,
          lineClient,
          parsed.lineUserId,
        );
      } catch (err) {
        console.error('[consent-callback] resume reservation failed', err);
      }
    }
    return c.json({ ok: true, resumedReservation });
  } catch (err) {
    return c.json({ ok: false, error: errorMessage(err) }, 500);
  }
});

// ── access_token verify (LINE Profile API) ───────────────────────────────────

/**
 * Authorization: Bearer <access_token> を LINE Profile API で verify し、
 * 認証済み LINE userId を返す。失敗時は null。
 */
export async function verifyAccessToken(
  authHeader: string | undefined,
): Promise<string | null> {
  const accessToken = bearerFromHeader(authHeader);
  if (!accessToken) return null;
  const res = await fetch(LINE_PROFILE_API, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const profile = (await res.json()) as { userId?: string };
  return typeof profile.userId === 'string' && profile.userId.length > 0
    ? profile.userId
    : null;
}

function bearerFromHeader(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

// ── Body parsing ─────────────────────────────────────────────────────────────

interface CallbackBody {
  lineUserId: string;
  accessToken: string | null;
  consentDocumentVersion: string;
  confirmationScreenShownAt: string;
  name: string;
  // ふりがな。本物の Google Form と同じく必須項目。
  kana: string;
  phone: string;
  // 任意フィールド (空文字許可)。住所・月間走行距離は customers 列に無く payload のみで保持。
  address: string;
  email: string;
  // 「200km」のような単位込み入力も受けられるよう文字列のまま保持する。
  monthlyDistance: string;
}

export function parseCallbackBody(
  raw: unknown,
): ({ ok: true } & CallbackBody) | { ok: false; reason: string } {
  if (!isRecord(raw)) {
    return { ok: false, reason: 'body must be a JSON object' };
  }
  const lineUserId = stringOrNull(raw.line_user_id);
  if (!lineUserId) {
    return { ok: false, reason: 'line_user_id is required' };
  }
  const consentDocumentVersion = stringOrNull(raw.consent_document_version);
  if (!consentDocumentVersion) {
    return { ok: false, reason: 'consent_document_version is required' };
  }
  const confirmationScreenShownAt = stringOrNull(raw.confirmation_screen_shown_at);
  if (!confirmationScreenShownAt) {
    return { ok: false, reason: 'confirmation_screen_shown_at is required' };
  }
  const name = stringOrNull(raw.name);
  if (!name) {
    return { ok: false, reason: 'name is required' };
  }
  // ふりがな: 本物の Google Form と同じく必須項目。
  const kana = stringOrNull(raw.kana);
  if (!kana) {
    return { ok: false, reason: 'kana is required' };
  }
  const phone = stringOrNull(raw.phone);
  if (!phone) {
    return { ok: false, reason: 'phone is required' };
  }
  return {
    ok: true,
    lineUserId,
    accessToken: stringOrNull(raw.access_token),
    consentDocumentVersion,
    confirmationScreenShownAt,
    name,
    kana,
    phone,
    // 任意フィールドは空文字を許可 (未入力でも submit を通す)。
    address: stringOrEmpty(raw.address),
    email: stringOrEmpty(raw.email),
    // string / number どちらでも受け、文字列として保持する。
    monthlyDistance: stringOrNumberAsString(raw.monthly_distance),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** 任意の文字列フィールド。未指定・非文字列は空文字に正規化する。 */
function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** string または number を受け、文字列に正規化する (「200km」等の単位込みも保持)。 */
function stringOrNumberAsString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
