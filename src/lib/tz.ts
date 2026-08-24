/**
 * The library's own timezone, made explicit.
 *
 * Nothing here reads the runtime's TZ. That is the point: Vercel's Node
 * runtime is UTC, so every `setHours(0,0,0,0)`, `getDay()` and bare
 * `toLocaleDateString()` in this codebase was silently computing a UTC
 * calendar day. Between midnight and 8am in Singapore the UTC day is
 * yesterday, so a loan due today read as overdue, a checkout in the small
 * hours got a due date a day early, and fines could be a day out.
 *
 * Everything below takes an instant and answers a question about the calendar
 * day in `LIBRARY_TZ`, or turns a wall clock in that zone into an instant.
 * Instants stay instants; only the interpretation is pinned.
 *
 * Client-safe: no Prisma, no server imports, Intl only. Both halves of the app
 * therefore agree, which also keeps server and client renders identical.
 */

/**
 * Asia/Singapore: UTC+8, and no daylight saving since 1982, so in practice a
 * fixed offset. The code below does not assume that (it asks Intl for the
 * offset at each instant), so moving the library to a zone with DST would not
 * silently break it.
 */
export const LIBRARY_TZ = "Asia/Singapore";

const DAY_MS = 86_400_000;

type Parts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Formatters are built on first use, not at module load.
 *
 * This module is now imported by format.ts and so, transitively, by most of
 * the app. Constructing Intl.DateTimeFormat at module scope would mean a
 * runtime without full ICU data throws at import time and takes down every
 * page, rather than one date rendering oddly. Built lazily, the blast radius
 * goes back to the call that needed it.
 */
function lazy<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

const parts = lazy(
  () =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: LIBRARY_TZ,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    }),
);

/** The wall clock in the library's zone at a given instant. */
function zonedParts(instant: Date): Parts {
  const found: Record<string, string> = {};
  for (const p of parts().formatToParts(instant)) {
    if (p.type !== "literal") found[p.type] = p.value;
  }
  return {
    year: Number(found.year),
    month: Number(found.month),
    day: Number(found.day),
    // Intl renders midnight as hour 24 in some engines; normalise it.
    hour: Number(found.hour) % 24,
    minute: Number(found.minute),
    second: Number(found.second),
    weekday: WEEKDAY_INDEX[found.weekday] ?? 0,
  };
}

/**
 * Offset of the library's zone at this instant, in milliseconds.
 *
 * The reconstructed wall clock has second resolution, so the instant is
 * floored to the second before subtracting or the result carries the
 * milliseconds as a spurious offset.
 */
function offsetMsAt(instant: Date): number {
  const p = zonedParts(instant);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const flooredToSecond = Math.floor(instant.getTime() / 1000) * 1000;
  return asIfUtc - flooredToSecond;
}

/** "YYYY-MM-DD" for the calendar day this instant falls on, in the library's zone. */
export function zonedDayKey(instant: Date): string {
  const p = zonedParts(instant);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** 0 (Sunday) to 6, for the calendar day this instant falls on. */
export function zonedWeekday(instant: Date): number {
  return zonedParts(instant).weekday;
}

/**
 * Turn a wall clock in the library's zone into the instant it names.
 *
 * Two passes, because the offset itself depends on the instant: guess by
 * reading the wall clock as if it were UTC, correct with the offset in force
 * there, then confirm. On a fixed-offset zone the second pass agrees with the
 * first; on a DST zone it lands on the right side of the transition.
 */
export function zonedWallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstGuess = asIfUtc - offsetMsAt(new Date(asIfUtc));
  const secondOffset = offsetMsAt(new Date(firstGuess));
  const corrected = asIfUtc - secondOffset;
  return new Date(corrected);
}

/** The instant at which the library's calendar day containing `instant` began. */
export function startOfZonedDay(instant: Date): Date {
  const p = zonedParts(instant);
  return zonedWallClockToInstant(p.year, p.month, p.day);
}

/**
 * The instant at which a "YYYY-MM-DD" calendar day begins in the library's zone.
 *
 * Memoised: it is a pure function of a small string, and the fine calculation
 * calls it once per configured closure date on every render of the loans page.
 */
const dayStartCache = new Map<string, Date | null>();

export function startOfZonedDayKey(key: string): Date | null {
  const hit = dayStartCache.get(key);
  if (hit !== undefined) return hit;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  const value = m ? zonedWallClockToInstant(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  // Bounded in practice by the number of distinct dates a session touches.
  if (dayStartCache.size < 5_000) dayStartCache.set(key, value);
  return value;
}

/**
 * Parse a `datetime-local` value, which is a wall clock with no zone, as a
 * wall clock in the library's zone.
 *
 * `new Date("2026-08-24T14:00")` is parsed as the RUNTIME's local time, so on
 * a UTC server a 2pm booking became 2pm UTC, which is 10pm in Singapore.
 * Returns null on anything malformed rather than an Invalid Date, so callers
 * have to handle it.
 */
export function parseZonedDateTimeLocal(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const instant = zonedWallClockToInstant(
    Number(y),
    Number(mo),
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? "0"),
  );
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/** A `datetime-local` input value for an instant, as the library's wall clock. */
export function toZonedDateTimeLocalValue(instant: Date): string {
  const p = zonedParts(instant);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * Whole calendar days from day `a` to day `b`, both "YYYY-MM-DD".
 *
 * Counted from each day's start instant and rounded, so an hour of DST
 * anywhere in between cannot turn 3 days into 2.
 */
export function daysBetweenDayKeys(a: string, b: string): number {
  const from = startOfZonedDayKey(a);
  const to = startOfZonedDayKey(b);
  if (!from || !to) return 0;
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

/** Whole calendar days between the days two instants fall on. Negative if `to` is earlier. */
export function daysBetweenInstants(from: Date, to: Date): number {
  return Math.round((startOfZonedDay(to).getTime() - startOfZonedDay(from).getTime()) / DAY_MS);
}

// ── Formatting ────────────────────────────────────────────────────────────
// Every rendered date and time goes through these. A bare
// toLocaleDateString() resolves to the runtime zone, so on Vercel the admin UI
// was showing UTC: an audit entry written at 09:15 Singapore read "01:15", and
// an hourly loan due at 17:00 read "due 09:00" all day long.

const dateFormatter = lazy(
  () =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: LIBRARY_TZ,
      day: "numeric",
      month: "short",
      year: "numeric",
    }),
);

const timeFormatter = lazy(
  () =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: LIBRARY_TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
);

const timeWithSecondsFormatter = lazy(
  () =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: LIBRARY_TZ,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }),
);

/** "24 Aug 2026", in the library's zone. */
export function formatZonedDate(instant: Date): string {
  return dateFormatter().format(instant);
}

/** "14:30", in the library's zone. Pass seconds for "14:30:07". */
export function formatZonedTime(instant: Date, withSeconds = false): string {
  return (withSeconds ? timeWithSecondsFormatter() : timeFormatter()).format(instant);
}

/** "24 Aug 2026, 14:30", in the library's zone. */
export function formatZonedDateTime(instant: Date): string {
  return `${formatZonedDate(instant)}, ${formatZonedTime(instant)}`;
}

/** "YYYY-MM" for the calendar month an instant falls in. */
export function zonedMonthKey(instant: Date): string {
  return zonedDayKey(instant).slice(0, 7);
}

/** "YYYY" for the calendar year an instant falls in. */
export function zonedYearKey(instant: Date): string {
  return zonedDayKey(instant).slice(0, 4);
}

/**
 * A half-open instant range for the calendar days `from`..`to` inclusive,
 * both "YYYY-MM-DD". Half-open so a row written in the final second of the
 * last day is included, which a `23:59:59` upper bound drops.
 *
 * This is the one range parser. Reports, FlexiReports and loan history each
 * had their own, all three built on `new Date("YYYY-MM-DD")`, which is UTC
 * midnight and therefore 08:00 in Singapore: every one of them silently
 * dropped the first eight hours of the opening day.
 */
export function zonedDayRange(
  from?: string | null,
  to?: string | null,
): { gte?: Date; lt?: Date } {
  const range: { gte?: Date; lt?: Date } = {};
  if (from) {
    const start = startOfZonedDayKey(from);
    if (start) range.gte = start;
  }
  if (to) {
    const end = startOfZonedDayKey(to);
    // The start of the NEXT day, found by asking which day contains noon
    // tomorrow. Adding 24h to a midnight is an hour out across a daylight
    // saving transition, which would contradict this module's whole claim not
    // to assume a fixed offset.
    if (end) range.lt = startOfZonedDay(new Date(end.getTime() + DAY_MS + DAY_MS / 2));
  }
  return range;
}

/**
 * The instant a calendar month begins in the library's zone, `offset` months
 * from the month containing `instant`. Negative offsets go back.
 *
 * Month buckets were derived with Date.UTC(now.getUTCFullYear(),
 * now.getUTCMonth() - i, 1), which on the 1st of a month between midnight and
 * 8am Singapore reads the previous month, shifting every dashboard's whole
 * twelve-month window back by one.
 */
export function startOfZonedMonth(instant: Date, offset = 0): Date {
  const [year, month] = zonedMonthKey(instant).split("-").map(Number);
  const zeroBased = month - 1 + offset;
  const y = year + Math.floor(zeroBased / 12);
  const m = ((zeroBased % 12) + 12) % 12;
  return zonedWallClockToInstant(y, m + 1, 1);
}

/** "YYYY-MM" for a month `offset` months from the one containing `instant`. */
export function zonedMonthKeyOffset(instant: Date, offset = 0): string {
  return zonedMonthKey(startOfZonedMonth(instant, offset));
}
