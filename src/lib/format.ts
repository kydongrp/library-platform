// Presentation helpers shared across server and client components.
//
// Dates and day counts resolve in the library's own zone, never the runtime's.
// See src/lib/tz.ts for why: on Vercel the runtime is UTC, so a bare
// toLocaleDateString() showed staff yesterday's date for the first eight hours
// of every Singapore day, and setHours(0, 0, 0, 0) bucketed "today" the same
// way.

import { daysBetweenInstants, formatZonedDate, formatZonedTime } from "@/lib/tz";

/**
 * Shown where a value is absent: an empty table cell reads as a rendering
 * fault, a dash reads as "nothing here". An en dash rather than an em dash,
 * which is banned in this codebase's copy.
 */
export const NO_VALUE = "–";

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return NO_VALUE;
  const d = typeof date === "string" ? new Date(date) : date;
  return formatZonedDate(d);
}

/** "14:30" in the library's zone. Pass true for "14:30:07". */
export function formatTime(
  date: Date | string | null | undefined,
  withSeconds = false,
): string {
  if (!date) return NO_VALUE;
  const d = typeof date === "string" ? new Date(date) : date;
  return formatZonedTime(d, withSeconds);
}

/**
 * Whole days until `due`, counted as calendar days in the library's zone.
 * Negative when overdue. `now` is injectable so the awkward instants either
 * side of midnight are testable.
 */
export function daysUntil(due: Date | string, now: Date = new Date()): number {
  const d = typeof due === "string" ? new Date(due) : due;
  return daysBetweenInstants(now, d);
}

export function isOverdue(due: Date | string, returnedAt?: Date | null, now?: Date): boolean {
  if (returnedAt) return false;
  return daysUntil(due, now) < 0;
}

/** "Due in 3 days", "Due today", "Overdue by 2 days". */
export function dueLabel(due: Date | string, returnedAt?: Date | null, now?: Date): string {
  if (returnedAt) return `Returned ${formatDate(returnedAt)}`;
  const n = daysUntil(due, now);
  if (n < 0) return `Overdue by ${Math.abs(n)} day${Math.abs(n) === 1 ? "" : "s"}`;
  if (n === 0) return "Due today";
  return `Due in ${n} day${n === 1 ? "" : "s"}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}
