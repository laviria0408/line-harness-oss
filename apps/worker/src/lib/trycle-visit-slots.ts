/**
 * 来店予定スロット生成 (REQ-PKG1-023・経路 D)。
 *
 * 整備は STORES 予約を受けず来店順対応のため、LINE 内で「営業時間内の来店予定
 * (時刻のみ)」を postback chain でヒアリングする (設計 v1.1.1 §3 経路 C/D・§8)。
 * trycle-store-hours.ts の validateVisitAt と対になる「候補生成」側。
 *
 * 出力は LINE datetimepicker と同じ "YYYY-MM-DDtHH:mm" (JST) 文字列で、
 * postback data=pkg1_visit_<value> に載せる。validateVisitAt で再検証する。
 */
import type { StoreRow, Weekday } from './trycle-repo.js';

const WEEKDAY_BY_INDEX: ReadonlyArray<Weekday> = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
];

const LABEL_BY_WEEKDAY: Record<Weekday, string> = {
  sun: '日',
  mon: '月',
  tue: '火',
  wed: '水',
  thu: '木',
  fri: '金',
  sat: '土',
};

/** 1 日あたり最大スロット数 (Bubble が縦に伸びすぎないよう制限)。 */
const MAX_SLOTS_PER_DAY = 12;

/**
 * 来店予定の先読み上限 (今日から 14 日後まで)。
 * 本物 (trycle-line-harness reservation 系) の運用に合わせ、遠すぎる来店予定は
 * 出さない (在庫・空き状況が読めないため)。指摘 2 の修正。
 */
export const MAX_DAYS_AHEAD = 14;

export interface VisitDay {
  /** "YYYY-MM-DD" (JST)。 */
  readonly date: string;
  /** "6/25 (木)" 表示用。 */
  readonly label: string;
  readonly slots: VisitSlot[];
}

export interface VisitSlot {
  /** "YYYY-MM-DDtHH:mm" (JST・postback / validateVisitAt 用)。 */
  readonly value: string;
  /** "14:30" 表示用。 */
  readonly label: string;
}

/**
 * 来店候補 1 件 (店舗 × 日 × 時刻を平坦化した row)。Option A の縦リスト UI 用。
 * 店舗 carousel + datetimepicker (自由カレンダー) は「分かりにくい」評価を受けたため、
 * 候補を 1 タップで選べる縦リストに置き換える (reservationSlotMessages が消費する)。
 */
export interface ReservationSlot {
  readonly storeId: string;
  /** 店舗略称 (stores.code・LINE Bubble 字数節約用・無ければ name で代替)。 */
  readonly storeAbbr: string;
  readonly storeName: string;
  /** "YYYY-MM-DD" (JST)。section label の日付グルーピング用。 */
  readonly date: string;
  /** "06/22 (土)" 表示用 (date 別 section label・MM/DD zero-pad)。 */
  readonly dateLabel: string;
  /** "10:00" 表示用 (tap row)。 */
  readonly timeLabel: string;
  /** "YYYY-MM-DDtHH:mm" (JST・postback / validateVisitAt 用)。 */
  readonly datetime: string;
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((s) => Number.parseInt(s, 10));
  return h * 60 + m;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `from` (JST 基準の Date) から `days` 日先までの営業日 × 営業時間内スロットを返す。
 * 当日分は now 以降のスロットのみ含める (過ぎた時刻は出さない)。定休日はスキップ。
 *
 * @param store         営業時間 / slot 刻みを持つ店舗
 * @param fromJst       基準時刻 (JST 壁時計を UTC フィールドに持たせた Date)
 * @param days          先読みする日数 (既定 = 今日含め 14 日先・MAX_DAYS_AHEAD で上限固定)
 */
export function generateVisitDays(
  store: StoreRow,
  fromJst: Date,
  days = MAX_DAYS_AHEAD,
): VisitDay[] {
  const result: VisitDay[] = [];
  const slotMinutes = store.reservation_slot_minutes > 0
    ? store.reservation_slot_minutes
    : 30;

  // 来店予定は今日から MAX_DAYS_AHEAD 日後までに制限 (指摘 2)。
  // 呼び出し側が大きい days を渡しても上限を超えない。
  const horizon = Math.min(days, MAX_DAYS_AHEAD);

  for (let offset = 0; offset < horizon; offset += 1) {
    const day = new Date(fromJst.getTime());
    day.setUTCDate(day.getUTCDate() + offset);
    const weekday = WEEKDAY_BY_INDEX[day.getUTCDay()];
    const hours = store.business_hours[weekday];
    if (!hours || hours.length === 0) continue; // 定休日

    const [openStr, closeStr] = hours;
    const openMin = hhmmToMinutes(openStr);
    const closeMin = hhmmToMinutes(closeStr);
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const dateStr = `${y}-${pad2(mo)}-${pad2(d)}`;

    // 当日は現在時刻以降のみ (次の slot 境界に切り上げ)。
    let startMin = openMin;
    if (offset === 0) {
      const nowMin = fromJst.getUTCHours() * 60 + fromJst.getUTCMinutes();
      if (nowMin >= openMin) {
        const next = Math.ceil(nowMin / slotMinutes) * slotMinutes;
        startMin = Math.max(openMin, next);
      }
    }

    const slots: VisitSlot[] = [];
    for (let min = startMin; min < closeMin; min += slotMinutes) {
      if (slots.length >= MAX_SLOTS_PER_DAY) break;
      const hh = Math.floor(min / 60);
      const mm = min % 60;
      const timeLabel = `${pad2(hh)}:${pad2(mm)}`;
      slots.push({
        value: `${dateStr}t${timeLabel}`,
        label: timeLabel,
      });
    }
    if (slots.length === 0) continue;

    result.push({
      date: dateStr,
      label: `${mo}/${d} (${LABEL_BY_WEEKDAY[weekday]})`,
      slots,
    });
  }
  return result;
}

/** stores.code を表示用略称に。null/空なら店舗名で代替する (字数節約は best-effort)。 */
function storeAbbr(store: StoreRow): string {
  const code = store.code?.trim();
  return code && code.length > 0 ? code : store.name;
}

/** "YYYY-MM-DD" → "06/22 (土)" (MM/DD zero-pad・曜日付き・JST)。 */
function dateLabelOf(dateStr: string): string {
  const [y, mo, d] = dateStr.split('-').map((s) => Number.parseInt(s, 10));
  // 正午 UTC で曜日を引く (日付境界の TZ ずれ回避)。曜日は date 文字列由来で確定。
  const wday = WEEKDAY_BY_INDEX[new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay()];
  return `${pad2(mo)}/${pad2(d)} (${LABEL_BY_WEEKDAY[wday]})`;
}

/**
 * 全営業店舗 × 今日から `days` 日先までの来店候補を「日付昇順 → 店舗の並び順」で
 * 平坦化した配列を返す (Option A の縦リスト UI 用)。各候補は店舗を内包するため、
 * 利用者は店舗 + 時刻の組を 1 タップで選べる (店舗選択ステップが不要になる)。
 *
 * 既存の generateVisitDays (店舗単位の営業日 × slot 列挙・定休/過去除外/14 日 clamp) を
 * 再利用するので、定休除外・slot grid・先読み上限のロジックは 1 箇所に集約される (DRY)。
 *
 * @param stores  営業中の店舗 (listActiveStores の結果・sort_order 昇順を保つ)
 * @param fromJst 基準時刻 (JST 壁時計を UTC フィールドに載せた Date・nowJst())
 * @param days    先読み日数 (既定 = MAX_DAYS_AHEAD・generateVisitDays 側で clamp)
 */
export function buildReservationSlots(
  stores: ReadonlyArray<StoreRow>,
  fromJst: Date,
  days = MAX_DAYS_AHEAD,
): ReservationSlot[] {
  // date → (store 並び順を保った) 候補。Map は挿入順を保つので店舗ループ後に
  // 日付昇順へ並べ替えるだけで「日付 → 店舗」順になる。
  const byDate = new Map<string, ReservationSlot[]>();

  for (const store of stores) {
    const abbr = storeAbbr(store);
    for (const day of generateVisitDays(store, fromJst, days)) {
      const bucket = byDate.get(day.date) ?? [];
      for (const slot of day.slots) {
        bucket.push({
          storeId: store.id,
          storeAbbr: abbr,
          storeName: store.name,
          date: day.date,
          dateLabel: dateLabelOf(day.date),
          timeLabel: slot.label,
          datetime: slot.value,
        });
      }
      byDate.set(day.date, bucket);
    }
  }

  // 日付昇順 (YYYY-MM-DD は辞書順 = 時系列順) に並べて平坦化。
  return [...byDate.keys()]
    .sort()
    .flatMap((date) => byDate.get(date) ?? []);
}

/**
 * JST の「今」を、UTC フィールドに JST 壁時計を載せた Date として返す
 * (trycle-store-hours.parseJstDatetime と同じ表現)。Worker は UTC で動くため
 * +9h して UTC フィールドに格納する。
 */
export function nowJst(now: Date = new Date()): Date {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000);
}
