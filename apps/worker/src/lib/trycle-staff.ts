/**
 * スタッフ引き継ぎ通知 + 問い合わせ振り分け (REQ-PKG1-017 / 024 / Add-D / Add-F)。
 *
 * スタッフ相談 / 有人切替時に、店舗スタッフへ会話の引き継ぎを Gmail で送る。
 * 同梱物 = 顧客情報 + (見積中なら) 見積サマリ + 見積 PDF URL + 自動タグ + 振り分け店舗。
 * 送信は個別維持 GAS (callGas gmail_notify)。宛先は env GMAIL_NOTIFICATION_TO。
 *
 * Add-D / Add-F (本物 shop-routing.ts port):
 *   - classifyInquiry(text): 問い合わせ種別を 8 tag に自動分類 (キーワード一致・AI なし)
 *   - routeInquiry(tag): カーボン補修=矢野口固定・それ以外は希望店舗 (既定 yano)
 *   - shopLabel(shop): 店舗 id → 表示名
 *
 * 設計: Pkg1 詳細設計 v1.2.1 §3 経路 A/D (page 386050ad6a7e81f8b701cd52c9201af6)。
 */
import type { Env } from '../index.js';
import { callGas } from './trycle-gas-client.js';

// ── Add-D / Add-F: 問い合わせ分類 + 店舗振り分け (本物 shop-routing.ts) ─────────

export type ShopId = 'yano' | 'miyagase';
export type InquiryTag =
  | 'estimate'
  | 'reservation'
  | 'faq'
  | 'consult'
  | 'carbon'
  | 'wage'
  | 'consent'
  | 'other';

export interface RoutingResult {
  readonly shopId: ShopId;
  readonly tag: InquiryTag;
  readonly staffEmailKey: 'yano_staff' | 'miyagase_staff' | 'head_office';
  readonly reason: string;
}

const YANO_ONLY_TAGS: ReadonlySet<InquiryTag> = new Set(['carbon']);

/**
 * REQ-ADD-D-001: 問い合わせ種別の自動タグ付け (キーワード一致・AI なし)。
 * 順序が重要: 「工賃表」を「工賃」(estimate) より先に判定。
 */
export function classifyInquiry(text: string): InquiryTag {
  const lower = text.toLowerCase();
  if (/カーボン|carbon|フレーム補修|フレームクラック/i.test(text)) return 'carbon';
  if (/工賃表/i.test(text)) return 'wage';
  if (/同意書|consent/i.test(lower)) return 'consent';
  if (/見積|工賃|整備/i.test(text)) return 'estimate';
  if (/予約|来店|booking|reserv/i.test(lower)) return 'reservation';
  if (/faq|よくある質問/i.test(lower)) return 'faq';
  if (/相談|スタッフ|staff|consult/i.test(lower)) return 'consult';
  return 'other';
}

/**
 * REQ-ADD-F-002 / REQ-ADD-D-002: tag + 希望店舗から対応店舗 + 担当者キーを決定。
 * カーボン補修は希望に関わらず矢野口固定。それ以外は preferredShop (既定 yano)。
 */
export function routeInquiry(tag: InquiryTag, preferredShop?: ShopId): RoutingResult {
  const wantsYano = YANO_ONLY_TAGS.has(tag);
  const shopId: ShopId = wantsYano ? 'yano' : preferredShop ?? 'yano';
  const staffEmailKey: RoutingResult['staffEmailKey'] =
    shopId === 'yano' ? 'yano_staff' : 'miyagase_staff';
  const reason = wantsYano
    ? 'カーボン補修は矢野口本店のみ対応 (REQ-ADD-F-002)'
    : `tag=${tag} を ${shopId} 店舗担当へ振り分け`;
  return { shopId, tag, staffEmailKey, reason };
}

/** Shop ID → 表示名 (店舗情報付与 REQ-ADD-F-001)。 */
export function shopLabel(id: ShopId): string {
  return id === 'yano' ? '矢野口本店' : '宮ヶ瀬店';
}

// ── スタッフ通知 ──────────────────────────────────────────────────────────────

export interface StaffNotifyInput {
  readonly lineUserId: string;
  /** 顧客表示名 (customers.name)。未取得なら null。 */
  readonly customerName: string | null;
  /** 相談のきっかけ ('包括メンテ' / '確定不能症状' / '来店予定の受付' 等)。 */
  readonly reason: string;
  /** 見積サマリ (cart があれば。無ければ null)。 */
  readonly estimateSummary: string | null;
  /** 見積 PDF URL (発行済なら)。 */
  readonly pdfUrl: string | null;
  /** 会話 sketch (任意・短い要約)。 */
  readonly note: string | null;
  /** 自動分類のもとにする本文 (なければ reason)。 */
  readonly inquiryText?: string;
  /** 希望店舗 (任意)。 */
  readonly preferredShop?: ShopId;
}

export interface StaffNotifyResult {
  readonly ok: boolean;
  readonly tag: InquiryTag;
  readonly shopId: ShopId;
  readonly error?: string;
}

/**
 * スタッフへ Gmail 通知を送る。GMAIL_NOTIFICATION_TO / GAS_WEB_APP_URL 未設定なら
 * no-op で ok=false を返す (呼び出し側は user 応答を止めない)。
 * 自動タグ (Add-D) + 店舗振り分け (Add-F) を payload + 本文に同梱する。
 */
export async function notifyStaff(
  env: Env['Bindings'],
  input: StaffNotifyInput,
): Promise<StaffNotifyResult> {
  const tag = classifyInquiry(input.inquiryText ?? input.reason);
  const routing = routeInquiry(tag, input.preferredShop);

  const to = env.GMAIL_NOTIFICATION_TO;
  if (!to) {
    return { ok: false, tag, shopId: routing.shopId, error: 'GMAIL_NOTIFICATION_TO not configured' };
  }
  const subject = `[TRYCLE] スタッフ相談リクエスト (${input.reason}・${shopLabel(routing.shopId)})`;
  const body = buildStaffEmailBody(input, routing);
  try {
    const res = await callGas(env, {
      type: 'gmail_notify',
      payload: {
        kind: 'staff_consult',
        to,
        subject,
        body,
        line_user_id: input.lineUserId,
        pdf_url: input.pdfUrl,
        tag,
        shop_id: routing.shopId,
        shop_label: shopLabel(routing.shopId),
        staff_email_key: routing.staffEmailKey,
        ts: new Date().toISOString(),
      },
    });
    return res.ok
      ? { ok: true, tag, shopId: routing.shopId }
      : { ok: false, tag, shopId: routing.shopId, error: res.error };
  } catch (err) {
    return {
      ok: false,
      tag,
      shopId: routing.shopId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** スタッフ向けメール本文を組む (機密値はコードに埋めない・実体は実行時の入力)。 */
export function buildStaffEmailBody(
  input: StaffNotifyInput,
  routing: RoutingResult,
): string {
  const lines: string[] = [
    'LINE からスタッフ相談のリクエストがありました。',
    '',
    `■ お客様: ${input.customerName ?? '(名前未取得)'}`,
    `■ LINE userId: ${input.lineUserId}`,
    `■ きっかけ: ${input.reason}`,
    `■ 種別タグ: ${routing.tag}`,
    `■ 対応店舗: ${shopLabel(routing.shopId)}`,
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
