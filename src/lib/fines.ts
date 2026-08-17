// Overdue fine accrual — pure, no Prisma, so it is client-safe and testable.
//
// A fine accrues per OPEN day the item is late (library closures are not
// chargeable), after the policy's grace period, capped at maxFineCents.
// While a loan is ACTIVE the figure is computed live against "now"; at
// check-in the same function assesses the amount that is frozen onto the loan.

import { openDaysBetween, type CalendarIndex } from "@/lib/calendar-core";

export type FinePolicy = {
  fineCentsPerDay: number;
  fineGraceDays: number;
  maxFineCents: number | null;
};

export type FineAssessment = {
  /** Open days past the due date, before grace is applied. */
  daysLate: number;
  /** Open days actually charged (daysLate minus grace, floored at 0). */
  chargeableDays: number;
  cents: number;
  capped: boolean;
};

export const NO_FINE: FineAssessment = {
  daysLate: 0,
  chargeableDays: 0,
  cents: 0,
  capped: false,
};

/**
 * What this loan owes as of `asOf` (the return date, or now for a live loan).
 * Returns zeroes when the item is not late or the member type is not fined.
 */
export function assessFine(
  dueAt: Date,
  asOf: Date,
  policy: FinePolicy,
  cal: CalendarIndex,
): FineAssessment {
  if (policy.fineCentsPerDay <= 0) return NO_FINE;

  const daysLate = openDaysBetween(dueAt, asOf, cal);
  if (daysLate <= 0) return NO_FINE;

  const chargeableDays = Math.max(0, daysLate - Math.max(0, policy.fineGraceDays));
  if (chargeableDays === 0) return { daysLate, chargeableDays: 0, cents: 0, capped: false };

  const raw = chargeableDays * policy.fineCentsPerDay;
  const cap = policy.maxFineCents;
  const cents = cap != null && cap >= 0 ? Math.min(raw, cap) : raw;
  return { daysLate, chargeableDays, cents, capped: cents < raw };
}

/** "S$1.20" from cents. Fines are always in the library's own currency. */
export function formatFine(cents: number, currency = "SGD"): string {
  try {
    return new Intl.NumberFormat("en-SG", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

/** Outstanding = assessed, not waived, not paid. */
export function isFineOutstanding(loan: {
  fineCents: number;
  finePaidAt: Date | null;
  fineWaivedAt: Date | null;
}): boolean {
  return loan.fineCents > 0 && !loan.finePaidAt && !loan.fineWaivedAt;
}
