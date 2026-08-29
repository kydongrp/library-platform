/**
 * Membership status: whether an account is suspended, and when it becomes so.
 *
 * There is one concept here, not two. A status either suspends the member or it
 * does not, and suspension means both things staff expect it to mean: no
 * borrowing at the desk, and no sign-in to the learner portal. The previous
 * model carried a separate "can borrow" flag alongside the status name, which
 * allowed a member to be not-suspended and yet unable to borrow, and required
 * staff to remember to set it on every status they created.
 *
 * Suspension can also be reached automatically. A status may declare
 * `autoAfterInactiveDays`, and the nightly job applies it to members who have
 * not borrowed or reserved anything in that long. That is the rule that
 * replaces the manual flag: an account lapses because nobody used it, not
 * because somebody remembered to tick a box.
 */
import { prisma } from "@/lib/db";

/** Statuses seeded on every deploy. */
export const SEED_MEMBER_STATUSES = [
  { name: "Active", suspends: false, isDefault: true, autoAfterInactiveDays: null },
  {
    name: "Suspended",
    suspends: true,
    isDefault: false,
    // Off until the library chooses a period; a lapse rule that arrives
    // switched on would suspend real members on the first night.
    autoAfterInactiveDays: null,
  },
  { name: "On Secondment", suspends: false, isDefault: false, autoAfterInactiveDays: null },
] as const;

/** Statuses no longer offered. Rows are removed; members keep their value. */
export const RETIRED_MEMBER_STATUSES = ["Alumni"] as const;

export type StatusRule = {
  name: string;
  suspends: boolean;
  isDefault: boolean;
  autoAfterInactiveDays: number | null;
};

/**
 * Whether a member with this status may borrow.
 *
 * The fallback matters: a member may carry a status string with no row behind
 * it, either from a bulk import or because the status was later removed from
 * the list. Reading that as "not suspended" would let a removed status silently
 * become permissive, so anything that is not recognisably active is treated as
 * suspended.
 */
export function statusAllowsBorrowing(
  status: string,
  rows: readonly { name: string; suspends: boolean }[],
): boolean {
  const row = rows.find((r) => r.name === status);
  if (row) return !row.suspends;
  return /^active$/i.test(status);
}

/** The same question, for one member, fetching the row. */
export async function memberMayBorrow(status: string): Promise<boolean> {
  const row = await prisma.memberStatus.findUnique({
    where: { name: status },
    select: { suspends: true },
  });
  if (row) return !row.suspends;
  return /^active$/i.test(status);
}

/** Names of every status that suspends, for filtering lists. */
export async function suspendingStatusNames(): Promise<Set<string>> {
  const rows = await prisma.memberStatus.findMany({
    where: { suspends: true },
    select: { name: true },
  });
  return new Set(rows.map((r) => r.name));
}

/**
 * The date a member was last active.
 *
 * Borrowing and reserving both count; browsing does not, because a member who
 * only ever looked at the catalogue has not used their membership in the sense
 * that matters for lapsing. Falls back to the join date so a member who never
 * borrowed still ages, rather than being immortal because they have no history.
 */
export function lastActiveAt(m: {
  joinedAt: Date;
  loans: { borrowedAt: Date; returnedAt: Date | null }[];
  reservations: { reservedAt: Date }[];
}): Date {
  const dates: Date[] = [m.joinedAt];
  for (const l of m.loans) {
    dates.push(l.borrowedAt);
    if (l.returnedAt) dates.push(l.returnedAt);
  }
  for (const r of m.reservations) dates.push(r.reservedAt);
  return dates.reduce((a, b) => (b > a ? b : a));
}

const DAY_MS = 86_400_000;

/** Whole days between two instants, floored and never negative. */
export function daysInactive(lastActive: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - lastActive.getTime()) / DAY_MS));
}

export type LapseDecision =
  | { lapse: false; reason: "no rule" | "still active" | "already suspended" | "open loans" }
  | { lapse: true; toStatus: string; daysInactive: number };

/**
 * Decide whether one member should be auto-suspended. Pure, so it is testable.
 *
 * Three deliberate refusals:
 *
 *   - A member already on a suspending status is left alone, so the job does
 *     not churn rows or re-audit the same suspension every night.
 *   - A member with an OPEN loan is never lapsed. They are demonstrably still
 *     holding library property, and suspending them would block the renewal
 *     and the return desk, turning a tidy-up into a queue at the counter.
 *   - No rule means no action. A library that has not chosen a period must not
 *     have one chosen for it.
 */
export function decideLapse(
  member: {
    status: string;
    openLoans: number;
    lastActive: Date;
  },
  rules: readonly StatusRule[],
  now: Date,
): LapseDecision {
  const current = rules.find((r) => r.name === member.status);
  if (current?.suspends) return { lapse: false, reason: "already suspended" };

  // The shortest configured period wins when several statuses declare one, so
  // adding a stricter rule takes effect rather than being masked by a laxer one.
  const candidates = rules
    .filter((r): r is StatusRule & { autoAfterInactiveDays: number } =>
      typeof r.autoAfterInactiveDays === "number" && r.autoAfterInactiveDays > 0,
    )
    .sort((a, b) => a.autoAfterInactiveDays - b.autoAfterInactiveDays);
  if (candidates.length === 0) return { lapse: false, reason: "no rule" };

  const days = daysInactive(member.lastActive, now);
  const hit = candidates.find((r) => days >= r.autoAfterInactiveDays);
  if (!hit) return { lapse: false, reason: "still active" };

  if (member.openLoans > 0) return { lapse: false, reason: "open loans" };

  return { lapse: true, toStatus: hit.name, daysInactive: days };
}
