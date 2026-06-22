/**
 * 見積番号採番 (bot 側・dashboard `lib/quote-number.ts` の port)。
 *
 * 形式: `Q-{店舗コード}-{YYYYMMDDHHMMSS}-{NNNNNN}-v{N}`
 *   - 店舗コード   = stores.code ("Y"=矢野口本店 / "M"=宮ヶ瀬店)
 *   - YYYYMMDDHHMMSS = JST 発行日時 (秒まで)
 *   - NNNNNN       = (店舗 × 会計年度 × quote_type) 通算連番 (6 桁ゼロ埋め)
 *   - vN           = バージョン (bot 発行は常に v1)
 *
 * 会計年度: 4 月始まり (Apr-Mar)。例 2026/01 → FY2025、2026/04 → FY2026。
 *
 * 連番は `tenant_fy_counters` の (tenant, store, fy, type) 単位。dashboard は
 * Postgres ON CONFLICT で atomic 増分するが、bot は PostgREST 経由のため
 * read-modify-write で増分する (bot は低頻度のため衝突確率は実用上無視できる。
 * 万一衝突しても quote_versions.quote_no は (quote_id, version) UNIQUE で別 quote
 * になるため、番号重複は dashboard 側の修正運用で吸収する)。
 *
 * 純粋関数 (fiscalYearFromDate / jstTimestamp / formatQuoteNo) は dashboard
 * lib/quote-number-utils.ts と同一ロジック。
 */
import { supabaseSelect, supabaseUpsert } from './supabase.js';
import { getTenantId, type TrycleRepoEnv } from './trycle-repo.js';

const JST_TZ = 'Asia/Tokyo';

export type QuoteType = 'estimate' | 'official';

export function fiscalYearFromDate(d: Date): number {
  const p = toJstParts(d);
  return p.month < 4 ? p.year - 1 : p.year;
}

export function jstTimestamp(d: Date): string {
  const p = toJstParts(d);
  return (
    pad4(p.year) +
    pad2(p.month) +
    pad2(p.day) +
    pad2(p.hour) +
    pad2(p.minute) +
    pad2(p.second)
  );
}

export function pad6(n: number): string {
  return String(n).padStart(6, '0');
}

export interface QuoteNumberParts {
  readonly storeCode: string;
  readonly timestamp: string;
  readonly seqNo: number;
  readonly version: number;
  readonly quoteType: QuoteType;
}

export function formatQuoteNo(parts: QuoteNumberParts): string {
  const prefix = parts.quoteType === 'official' ? 'Q' : 'E';
  return `${prefix}-${parts.storeCode}-${parts.timestamp}-${pad6(parts.seqNo)}-v${parts.version}`;
}

interface CounterRow {
  readonly last_seq: number;
}

/**
 * (tenant, store, fy, type) の連番を 1 進めて返す。
 * read (現在の last_seq) → write (last_seq + 1) の read-modify-write。
 */
export async function nextSeqNo(
  env: TrycleRepoEnv,
  input: {
    storeId: string;
    fyYear: number;
    quoteType: QuoteType;
  },
): Promise<number> {
  const tenantId = getTenantId(env);
  const filter = {
    tenant_id: `eq.${tenantId}`,
    store_id: `eq.${input.storeId}`,
    fy_year: `eq.${input.fyYear}`,
    quote_type: `eq.${input.quoteType}`,
  };
  const rows = await supabaseSelect<CounterRow>(env, 'tenant_fy_counters', filter, {
    select: 'last_seq',
    limit: 1,
  });
  const nextSeq = (rows[0]?.last_seq ?? 0) + 1;
  await supabaseUpsert(
    env,
    'tenant_fy_counters',
    [
      {
        tenant_id: tenantId,
        store_id: input.storeId,
        fy_year: input.fyYear,
        quote_type: input.quoteType,
        last_seq: nextSeq,
        updated_at: new Date().toISOString(),
      },
    ],
    { onConflict: 'tenant_id,store_id,fy_year,quote_type' },
  );
  return nextSeq;
}

/**
 * 採番 1 回分: storeCode / now から quote_no を組み立てて返す。
 * bot 発行は version=1 固定。
 */
export async function issueQuoteNo(
  env: TrycleRepoEnv,
  input: {
    storeId: string;
    storeCode: string;
    quoteType: QuoteType;
    now?: Date;
  },
): Promise<{ quoteNo: string; seqNo: number; fyYear: number; version: number }> {
  const now = input.now ?? new Date();
  const fyYear = fiscalYearFromDate(now);
  const seqNo = await nextSeqNo(env, { storeId: input.storeId, fyYear, quoteType: input.quoteType });
  const version = 1;
  const quoteNo = formatQuoteNo({
    storeCode: input.storeCode,
    timestamp: jstTimestamp(now),
    seqNo,
    version,
    quoteType: input.quoteType,
  });
  return { quoteNo, seqNo, fyYear, version };
}

// ── JST parts helpers (dashboard quote-number-utils.ts と同一) ────────────────

interface JstParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function toJstParts(d: Date): JstParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: JST_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') === 24 ? 0 : get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function pad4(n: number): string {
  return String(n).padStart(4, '0');
}
