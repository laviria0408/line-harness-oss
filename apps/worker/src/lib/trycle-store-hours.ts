/**
 * Business-hours validator (TRYCLE Phase B-3).
 *
 * Why a Date-in / verdict-out function?
 *   The LINE datetime picker hands us a JST-formatted string ("YYYY-MM-DDtHH:mm")
 *   which we parse as a local Date. The Worker is UTC; we treat the string as JST
 *   regardless of the Worker's TZ to avoid off-by-9-hours bugs.
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

/**
 * Parse "YYYY-MM-DDtHH:mm" (LINE datetimepicker format) as JST. Returns null on
 * malformed input. The result is a Date whose UTC fields match the JST clock
 * (Y/M/D/H/M); local-TZ accessors on the Worker (which runs in UTC) would
 * otherwise drift.
 */
export function parseJstDatetime(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[tT](\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  // Construct as UTC; downstream comparisons are wall-clock, not TZ-aware.
  const date = new Date(
    Date.UTC(
      Number.parseInt(y, 10),
      Number.parseInt(mo, 10) - 1,
      Number.parseInt(d, 10),
      Number.parseInt(h, 10),
      Number.parseInt(mi, 10),
    ),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function weekdayOfUTC(date: Date): Weekday {
  return WEEKDAY_BY_INDEX[date.getUTCDay()];
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((s) => Number.parseInt(s, 10));
  return h * 60 + m;
}

export type VisitVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Returns ok=true if the proposed visit time falls inside the store's open
 * hours for that weekday AND on the slot grid. Otherwise returns a human
 * reason for re-prompt.
 */
export function validateVisitAt(store: StoreRow, visitAt: Date): VisitVerdict {
  const wday = weekdayOfUTC(visitAt);
  const hours = store.business_hours[wday];
  if (!hours || hours.length === 0) {
    return {
      ok: false,
      reason: `${LABEL_BY_WEEKDAY[wday]}曜日は定休日です。`,
    };
  }
  const [openStr, closeStr] = hours;
  const openMin = hhmmToMinutes(openStr);
  const closeMin = hhmmToMinutes(closeStr);
  const targetMin = visitAt.getUTCHours() * 60 + visitAt.getUTCMinutes();
  if (targetMin < openMin || targetMin >= closeMin) {
    return { ok: false, reason: `営業時間は ${openStr}〜${closeStr} です。` };
  }
  const slot = store.reservation_slot_minutes;
  if (targetMin % slot !== 0) {
    return { ok: false, reason: `${slot}分刻みでお選びください。` };
  }
  return { ok: true };
}
