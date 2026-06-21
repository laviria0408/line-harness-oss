/**
 * スタッフ引き継ぎ通知 (REQ-PKG1-017 / REQ-PKG1-024)。
 *
 * スタッフ相談 / 有人切替時に、店舗スタッフへ会話の引き継ぎを Gmail で送る。
 * 同梱物 = 顧客情報 + (見積中なら) 見積サマリ + 見積 PDF URL + 会話 sketch。
 * 送信は個別維持 GAS (callGas gmail_notify)。宛先は env GMAIL_NOTIFICATION_TO。
 *
 * 設計: Pkg1 詳細設計 v1.1.1 §3 経路 A/D (page 386050ad6a7e81f8b701cd52c9201af6)。
 */
import type { Env } from '../index.js';
import { callGas } from './trycle-gas-client.js';

export interface StaffNotifyInput {
  readonly lineUserId: string;
  /** 顧客表示名 (LINE profile or customers.name)。未取得なら null。 */
  readonly customerName: string | null;
  /** 相談のきっかけ ('包括メンテ' / '原因不明' / '見積後相談' / '見積不可症状')。 */
  readonly reason: string;
  /** 見積サマリ (cart があれば。無ければ null)。 */
  readonly estimateSummary: string | null;
  /** 見積 PDF URL (発行済なら)。 */
  readonly pdfUrl: string | null;
  /** 会話 sketch (任意・短い要約)。 */
  readonly note: string | null;
}

export interface StaffNotifyResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * スタッフへ Gmail 通知を送る。GMAIL_NOTIFICATION_TO / GAS_WEB_APP_URL 未設定なら
 * no-op で ok=false を返す (呼び出し側は user 応答を止めない)。
 */
export async function notifyStaff(
  env: Env['Bindings'],
  input: StaffNotifyInput,
): Promise<StaffNotifyResult> {
  const to = env.GMAIL_NOTIFICATION_TO;
  if (!to) {
    return { ok: false, error: 'GMAIL_NOTIFICATION_TO not configured' };
  }
  const subject = `[TRYCLE] スタッフ相談リクエスト (${input.reason})`;
  const body = buildStaffEmailBody(input);
  try {
    const res = await callGas(env, {
      type: 'gmail_notify',
      payload: {
        to,
        subject,
        body,
        line_user_id: input.lineUserId,
        pdf_url: input.pdfUrl,
      },
    });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** スタッフ向けメール本文を組む (機密値はコードに埋めない・実体は実行時の入力)。 */
export function buildStaffEmailBody(input: StaffNotifyInput): string {
  const lines: string[] = [
    'LINE からスタッフ相談のリクエストがありました。',
    '',
    `■ お客様: ${input.customerName ?? '(名前未取得)'}`,
    `■ LINE userId: ${input.lineUserId}`,
    `■ きっかけ: ${input.reason}`,
  ];
  if (input.estimateSummary) {
    lines.push('', '■ 見積サマリ', input.estimateSummary);
  }
  if (input.pdfUrl) {
    lines.push('', `■ 見積 PDF: ${input.pdfUrl}`);
  }
  if (input.note) {
    lines.push('', '■ メモ', input.note);
  }
  lines.push(
    '',
    '※ このお客様は有人モードに切り替わっています。LINE 個別チャットでご対応ください。',
    '※ お客様がリッチメニューを押すと bot 自動応答に復帰します。',
  );
  return lines.join('\n');
}
