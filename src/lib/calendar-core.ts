// Library service calendar — pure date math, no Prisma, so it is client-safe
// and directly testable with tsx. The Prisma-backed loader lives in
// src/lib/calendar.ts.
//
// Date keying is in the library's own zone, via src/lib/tz.ts.
//
// It used to be UTC, on the argument that date-only values are stored at noon
// UTC and therefore key to the same calendar day in Singapore. That argument
// is sound, and it is still true of stored date-only values. What it missed is
// that these functions are handed INSTANTS too: dueDateFrom(new Date(), ...),
// isOpenDay(dueInstant, ...), openDaysBetween(dueAt, now, ...). The UTC day of
// an instant between midnight and 8am Singapore is yesterday, so a checkout in
// the small hours rolled its due date against the wrong weekday, and a fine
// could come out a day wrong in either direction.
//
// Noon-UTC values are unaffected: noon UTC is 20:00 in Singapore, the same
// calendar day, so their key is identical either way.

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

import { startOfZonedDay, startOfZonedDayKey, zonedDayKey, zonedWeekday } from "@/lib/tz";

const DAY_MS = 86_400_000;
/** Bound every calendar walk so a misconfigured calendar can't spin forever. */
const MAX_WALK_DAYS = 400;

export type CalendarIndex = {
  closedWeekdays: Set<number>; // 0 = Sunday … 6 = Saturday
  closedDates: Set<string>; // "YYYY-MM-DD"
};

/** "YYYY-MM-DD" for a timestamp, as the calendar day in the library's zone. */
export function dateKey(d: Date): string {
  return zonedDayKey(d);
}

/** Parse "YYYY-MM-DD" to a noon-UTC Date; null if malformed. */
export function parseDateKey(raw: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Build the lookup index. A calendar that closes all seven weekdays is a
 * configuration error — the weekly rule is dropped so the library is not
 * permanently shut (specific closure dates still apply).
 */
export function buildCalendar(closedWeekdays: number[], closedDates: string[]): CalendarIndex {
  const weekdays = new Set(closedWeekdays.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6));
  return {
    closedWeekdays: weekdays.size >= 7 ? new Set<number>() : weekdays,
    closedDates: new Set(closedDates),
  };
}

export const ALWAYS_OPEN: CalendarIndex = {
  closedWeekdays: new Set<number>(),
  closedDates: new Set<string>(),
};

export function isOpenDay(date: Date, cal: CalendarIndex): boolean {
  return !cal.closedWeekdays.has(zonedWeekday(date)) && !cal.closedDates.has(dateKey(date));
}

/** The date itself when open, otherwise the next open day (time preserved). */
export function nextOpenDay(date: Date, cal: CalendarIndex): Date {
  let d = date;
  for (let i = 0; i < MAX_WALK_DAYS; i++) {
    if (isOpenDay(d, cal)) return d;
    d = new Date(d.getTime() + DAY_MS);
  }
  return date; // unreachable in practice; never loop forever
}

/**
 * Due date for a loan: calendar days from `start`, then rolled forward to the
 * next day the library is actually open (a book can't be due on a closed day).
 */
export function dueDateFrom(start: Date, loanDays: number, cal: CalendarIndex): Date {
  return nextOpenDay(new Date(start.getTime() + loanDays * DAY_MS), cal);
}

/** Start of the library day containing a timestamp, as epoch ms. */
function dayStart(d: Date): number {
  return startOfZonedDay(d).getTime();
}

/** How many of the `n` days starting at `firstDow` fall on weekday `w`. */
function weekdayOccurrences(firstDow: number, n: number, w: number): number {
  if (n <= 0) return 0;
  const offset = (((w - firstDow) % 7) + 7) % 7;
  return offset >= n ? 0 : Math.floor((n - 1 - offset) / 7) + 1;
}

/**
 * Open days strictly after `from`, up to and including `to`. This is the
 * chargeable-days count for fines: a book due Friday and returned Monday over
 * a weekend the library is shut is one open day late, not three.
 * Returns 0 when `to` is not after `from`.
 *
 * Counted arithmetically rather than by walking day by day, so a loan overdue
 * for years is still charged exactly — a bounded loop would silently stop
 * counting and under-charge.
 */
export function openDaysBetween(from: Date, to: Date, cal: CalendarIndex): number {
  const start = dayStart(from);
  const end = dayStart(to);
  const totalDays = Math.round((end - start) / DAY_MS);
  if (totalDays <= 0) return 0;

  // The window is the `totalDays` days start+1 … end (inclusive). Take the
  // weekday from the MIDDLE of the first of them rather than its midnight: on
  // a zone with daylight saving, a midnight plus 24h can land an hour either
  // side of the boundary and name the wrong weekday.
  const firstDow = zonedWeekday(new Date(start + DAY_MS + DAY_MS / 2));
  let closed = 0;
  for (const w of cal.closedWeekdays) closed += weekdayOccurrences(firstDow, totalDays, w);

  // Explicit closure dates inside the window that aren't already weekly ones.
  for (const key of cal.closedDates) {
    const dayOpen = startOfZonedDayKey(key);
    if (!dayOpen) continue;
    if (cal.closedWeekdays.has(zonedWeekday(new Date(dayOpen.getTime() + DAY_MS / 2)))) continue;
    const t = dayOpen.getTime();
    if (t > start && t <= end) closed++;
  }

  return Math.max(0, totalDays - closed);
}
