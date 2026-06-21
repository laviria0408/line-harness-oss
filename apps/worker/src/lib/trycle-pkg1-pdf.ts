/**
 * Pkg1 見積 PDF 発行 (REQ-PKG1-012〜015・経路 D-1/D-2・Step 6)。
 *
 * 個別維持 GAS (callGas estimate_pdf) で PDF を生成し Drive 保存する。
 * テンプレ正本 = 2026-06-12 ヒアリングのモック PWA 見積プレビュー (REQ-PKG1-013)。
 * GAS 側がテンプレを持つため、bot は quote payload を渡すだけ。
 *
 * 【I/O 契約 (正本)】callGas payload / GAS handler の I/O は
 *   `trycle-line-harness/src/flows/pkg1-estimate.ts issueQuote` +
 *   `trycle-line-harness/gas/handlers.gs handleEstimatePdf` を正本とする。
 *   - payload: { userId, contact:{name,phone}, lineItems[ {name,unitPrice,qty,amount,priceOpenEnded} ],
 *               subtotal, tax, total, totalMax, disclaimer }  ← すべて camelCase
 *   - GAS テンプレ (templates.gs buildQuoteHtml) は it.name / it.unitPrice / it.qty /
 *     it.amount / it.priceOpenEnded を読む。snake_case は読まれず空明細になる。
 *   - 戻り値: { ok, data:{ quoteNo, driveUrl, estimateAmount } }  ← URL キーは driveUrl
 *
 * 【移植事故 (本ファイルが直した bug)】worker への port 時に payload を snake_case
 *   (line_items/unit_price/customer_name…) に変えてしまい GAS が明細を読めず、かつ
 *   戻り値を data.pdfUrl で読んでいたため driveUrl を取りこぼし、PDF URL が常に
 *   undefined → 「準備中/失敗」表示になっていた。正本 camelCase + driveUrl に戻す。
 *
 * 【v1.2.1: 概算見積 PDF に LINE userId 記載】payload.userId に LINE userId を渡す
 *   (店員追跡用・GAS の logUsage に乗る)。GAS テンプレ側の印字位置追加は別 task。
 *
 * 設計: Pkg1 詳細設計 v1.2.1 §3 経路 D / §5 (page 386050ad6a7e81f8b701cd52c9201af6)。
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
  /** 【v1.2.1】概算見積 PDF / GAS ログに残す LINE userId (店員追跡用)。 */
  readonly lineUserId: string;
}

/**
 * GAS で見積 PDF を生成 + Drive 保存し、PDF URL を返す。
 * GAS_WEB_APP_URL 未設定なら ok=false (呼び出し側は LINE 共有を skip)。
 *
 * payload は正本 (pkg1-estimate.ts issueQuote) と同じ camelCase 形にする。
 * GAS handleEstimatePdf が返す data.driveUrl を pdfUrl として返す。
 */
export async function issueEstimatePdf(
  env: Env['Bindings'],
  input: EstimatePdfInput,
): Promise<EstimatePdfResult> {
  try {
    const { quote } = input;
    const res = await callGas(env, {
      type: 'estimate_pdf',
      payload: {
        // ── 正本 envelope (GAS handlers.gs / templates.gs が読む camelCase) ──
        userId: input.lineUserId, // 店員追跡用 (GAS logUsage)
        contact: {
          name: input.customerName ?? 'お客様',
          phone: '—',
        },
        // GAS テンプレは it.name / it.unitPrice / it.qty / it.amount / it.priceOpenEnded を読む。
        // worker の QuoteLineItem は既に camelCase。unitPriceMax があれば上限なし扱い (〜表示)。
        lineItems: quote.lineItems.map((li) => ({
          name: li.name,
          unitPrice: li.unitPrice,
          qty: li.qty,
          amount: li.amount,
          priceOpenEnded: li.unitPriceMax !== null && li.unitPriceMax !== undefined,
          ...(li.notes ? { notes: li.notes } : {}),
        })),
        subtotal: quote.subtotal,
        tax: quote.tax,
        total: quote.total,
        totalMax: quote.totalMax,
        disclaimer: quote.disclaimer,
        // ── worker 拡張 (GAS が無視しても害なし。Notion/店舗識別の補助) ──
        is_estimate: true, // 「概算」明示 (REQ-PKG1-009)
        store_name: input.storeName,
        quote_no: input.quoteNo,
      },
    });
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    const data = res.data ?? {};
    // 正本 GAS は driveUrl を返す。後方互換で pdfUrl も拾う。
    const driveUrl = typeof data.driveUrl === 'string' ? data.driveUrl : undefined;
    const pdfUrl =
      driveUrl ?? (typeof data.pdfUrl === 'string' ? data.pdfUrl : undefined);
    const thumbUrl = typeof data.thumbUrl === 'string' ? data.thumbUrl : undefined;
    return { ok: true, pdfUrl, thumbUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
