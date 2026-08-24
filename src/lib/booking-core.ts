/**
 * Booking rules (SDD rows 52-53). Pure so it's tsx-testable; the booking
 * actions do the reads and writes.
 *
 * A booking holds one SPECIFIC copy for a definite window. That is what
 * separates it from a reservation, which queues for a title currently on
 * loan. The rule that matters is that a copy is one physical object: two live
 * bookings for the same copy may never overlap.
 */

import { formatZonedDate, formatZonedTime } from "@/lib/tz";

/** Statuses that still commit the copy. A cancelled or no-show booking does not. */
export const LIVE_BOOKING_STATUSES = ["REQUESTED", "CONFIRMED"] as const;

export const BOOKING_STATUSES = [
  "REQUESTED",
  "CONFIRMED",
  "COLLECTED",
  "CANCELLED",
  "NO_SHOW",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const BOOKING_STATUS_LABELS: Record<string, string> = {
  REQUESTED: "Requested",
  CONFIRMED: "Confirmed",
  COLLECTED: "Collected",
  CANCELLED: "Cancelled",
  NO_SHOW: "Not collected",
};

export type Window = { startAt: Date; endAt: Date };

/** Longest window a single booking may span, so a typo cannot tie a copy up for a year. */
export const MAX_BOOKING_DAYS = 30;
/** How far ahead a booking may be placed. */
export const MAX_LEAD_DAYS = 365;

const DAY = 86_400_000;

export type WindowProblem =
  | "END_BEFORE_START"
  | "ZERO_LENGTH"
  | "TOO_LONG"
  | "TOO_FAR_AHEAD"
  | "IN_THE_PAST";

export function validateWindow(w: Window, now = new Date()): WindowProblem | null {
  const start = w.startAt.getTime();
  const end = w.endAt.getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return "END_BEFORE_START";
  if (end < start) return "END_BEFORE_START";
  if (end === start) return "ZERO_LENGTH";
  // A booking that has already finished can never be collected.
  if (end <= now.getTime()) return "IN_THE_PAST";
  if (end - start > MAX_BOOKING_DAYS * DAY) return "TOO_LONG";
  if (start - now.getTime() > MAX_LEAD_DAYS * DAY) return "TOO_FAR_AHEAD";
  return null;
}

export const WINDOW_PROBLEM_MESSAGE: Record<WindowProblem, string> = {
  END_BEFORE_START: "The end of the window must be after the start.",
  ZERO_LENGTH: "The window has no length. Set an end time after the start.",
  TOO_LONG: `A single booking cannot run longer than ${MAX_BOOKING_DAYS} days.`,
  TOO_FAR_AHEAD: `Bookings cannot be placed more than ${MAX_LEAD_DAYS} days ahead.`,
  IN_THE_PAST: "That window has already ended.",
};

/**
 * Half-open overlap: [start, end). Two bookings that merely touch (one
 * ending exactly when the next begins) do NOT overlap, which is what lets a
 * copy be handed straight from one borrower to the next at 2pm.
 */
export function overlaps(a: Window, b: Window): boolean {
  return a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime();
}

/** The first existing booking that clashes with `w`, or null. */
export function findClash<T extends Window>(w: Window, existing: T[]): T | null {
  return existing.find((e) => overlaps(w, e)) ?? null;
}

/** A booking is collectable once its window has opened and not yet closed. */
export function isCollectable(
  b: { status: string; startAt: Date; endAt: Date },
  now = new Date(),
): boolean {
  if (b.status !== "CONFIRMED") return false;
  return b.startAt.getTime() <= now.getTime() && now.getTime() < b.endAt.getTime();
}

/** Confirmed, window opened, still uncollected past the end: a no-show. */
export function isNoShow(
  b: { status: string; endAt: Date },
  now = new Date(),
): boolean {
  return (
    (b.status === "CONFIRMED" || b.status === "REQUESTED") && b.endAt.getTime() <= now.getTime()
  );
}

/** Human summary of a window, collapsing same-day ranges to one date. */
export function describeWindow(w: Window): string {
  // Rendered in the library's zone, and this had to change in the same commit
  // as the parse in actions/bookings.ts. While both were UTC they cancelled on
  // screen: a window typed as 2pm-4pm read back as 2pm-4pm even though it was
  // stored as 10pm-midnight. Fixing either half alone would have made every
  // correctly-entered booking look eight hours wrong.
  const sameDay = formatZonedDate(w.startAt) === formatZonedDate(w.endAt);
  const start = `${formatZonedDate(w.startAt)}, ${formatZonedTime(w.startAt)}`;
  const end = sameDay
    ? formatZonedTime(w.endAt)
    : `${formatZonedDate(w.endAt)}, ${formatZonedTime(w.endAt)}`;
  return `${start} – ${end}`;
}

