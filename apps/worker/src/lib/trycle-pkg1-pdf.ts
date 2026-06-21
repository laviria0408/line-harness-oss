/**
 * Pkg1 見積 PDF 発行 (REQ-PKG1-012〜015・経路 D・Step 6)。
 *
 * 個別維持 GAS (callGas estimate_pdf) で PDF を生成し Drive 保存する。
 * テンプレ正本 = 2026-06-12 ヒアリングのモック PWA 見積プレビュー (REQ-PKG1-013)。
 * GAS 側がテンプレを持つため、bot は quote payload を渡すだけ。
 *
 * 設計: Pkg1 詳細設計 v1.1.1 §3 経路 D / §5 (page 386050ad6a7e81f8b701cd52c9201af6)。
 */
import type { Env } from '../index.js';
import { callGas } from './trycle-gas-client.js';
import type { Quote } from './quote.js';

export interface EstimatePdfResult {
  readonly ok: boolean;
  readonly pdfUrl?: string;
  readonly thumbUrl?: string;
  readonly error?: string;
}

export interface EstimatePdfInput {
  readonly quote: Quote;
  readonly customerName: string | null;
  readonly storeName: string | null;
  readonly quoteNo: string | null;
  readonly partsNotice: string;
  readonly disclaimer: string;
}

/**
 * GAS で見積 PDF を生成 + Drive 保存し、PDF URL を返す。
 * GAS_WEB_APP_URL 未設定なら ok=false (呼び出し側は LINE 共有を skip)。
 */
export async function issueEstimatePdf(
  env: Env['Bindings'],
  input: EstimatePdfInput,
): Promise<EstimatePdfResult> {
  try {
    const res = await callGas(env, {
      type: 'estimate_pdf',
      payload: {
        // GAS テンプレ (PWA mock 準拠) が読む見積データ。明細は工賃のみ。
        is_estimate: true, // 「概算」明示 (REQ-PKG1-009)
        customer_name: input.customerName,
        store_name: input.storeName,
        quote_no: input.quoteNo,
        line_items: input.quote.lineItems.map((li) => ({
          name: li.name,
          unit_price: li.unitPrice,
          unit_price_max: li.unitPriceMax,
          qty: li.qty,
          amount: li.amount,
          amount_max: li.amountMax,
          notes: li.notes ?? null,
        })),
        subtotal: input.quote.subtotal,
        subtotal_max: input.quote.subtotalMax,
        tax: input.quote.tax,
        tax_max: input.quote.taxMax,
        total: input.quote.total,
        total_max: input.quote.totalMax,
        parts_notice: input.partsNotice,
        disclaimer: input.disclaimer,
      },
    });
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    const data = res.data ?? {};
    const pdfUrl = typeof data.pdfUrl === 'string' ? data.pdfUrl : undefined;
    const thumbUrl = typeof data.thumbUrl === 'string' ? data.thumbUrl : undefined;
    return { ok: true, pdfUrl, thumbUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
