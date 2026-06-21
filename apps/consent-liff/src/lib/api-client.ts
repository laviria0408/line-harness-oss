// bot worker endpoint への通信。
//   GET  /api/consent-document  … 最新の有効な同意書文面を取得
//   POST /api/consent-callback  … 同意内容を submit
import { getSession } from './liff-client.js';

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

export interface ConsentDocument {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly body_md: string;
}

export interface ConsentSubmission {
  readonly name: string;
  readonly kana: string;
  readonly phone: string;
  readonly address: string;
  readonly email: string;
  // 月間走行距離。「200km」のような単位込み入力も壊さないよう文字列で保持する。
  readonly monthlyDistance: string;
  readonly consentDocumentVersion: string;
  readonly confirmationScreenShownAt: string;
}

function buildUrl(path: string): string {
  return new URL(`${BASE}${path}`, window.location.origin).toString();
}

/** 最新の有効な同意書文面を取得する。 */
export async function fetchConsentDocument(): Promise<ConsentDocument> {
  const res = await fetch(buildUrl('/api/consent-document'), {
    headers: { Authorization: `Bearer ${getSession().accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`同意書の取得に失敗しました (${res.status})`);
  }
  const json = (await res.json()) as Partial<ConsentDocument> & { error?: string };
  if (!json.id || !json.version || !json.title || json.body_md === undefined) {
    throw new Error(json.error ?? '同意書の文面が見つかりませんでした');
  }
  return {
    id: json.id,
    version: json.version,
    title: json.title,
    body_md: json.body_md,
  };
}

/** 同意内容を bot endpoint へ送信する。 */
export async function submitConsent(input: ConsentSubmission): Promise<void> {
  const session = getSession();
  const res = await fetch(buildUrl('/api/consent-callback'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify({
      line_user_id: session.lineUserId,
      access_token: session.accessToken,
      consent_document_version: input.consentDocumentVersion,
      confirmation_screen_shown_at: input.confirmationScreenShownAt,
      name: input.name,
      kana: input.kana,
      phone: input.phone,
      address: input.address,
      email: input.email,
      monthly_distance: input.monthlyDistance,
    }),
  });
  if (!res.ok) {
    let message = `送信に失敗しました (${res.status})`;
    try {
      const json = (await res.json()) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  const json = (await res.json()) as { ok?: boolean; error?: string };
  if (!json.ok) {
    throw new Error(json.error ?? '送信に失敗しました');
  }
}
