// Client-safe serials vocabulary and prediction math: NO prisma imports, so
// client components (widgets) can use it without dragging pg into the bundle.
// Server-side rollups and claims live in src/lib/serials.ts, which re-exports
// everything here.

export const FREQUENCIES = [
  "WEEKLY",
  "BIWEEKLY",
  "MONTHLY",
  "BIMONTHLY",
  "QUARTERLY",
  "SEMIANNUAL",
  "ANNUAL",
] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  WEEKLY: "Weekly",
  BIWEEKLY: "Every 2 weeks",
  MONTHLY: "Monthly",
  BIMONTHLY: "Every 2 months",
  QUARTERLY: "Quarterly",
  SEMIANNUAL: "Twice a year",
  ANNUAL: "Annual",
};

/** An issue is "late" once it's this many days past its expected date. */
export const GRACE_DAYS = 7;
/** Keep at least this many upcoming issues on the schedule after a check-in. */
export const MIN_UPCOMING = 3;
/** How many issues "extend schedule" (and auto top-up) adds at a time. */
export const EXTEND_BY = 6;

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The next expected date after `from` for a publication pattern. */
export function nextExpected(freq: Frequency, from: Date): Date {
  switch (freq) {
    case "WEEKLY":
      return new Date(from.getTime() + 7 * DAY_MS);
    case "BIWEEKLY":
      return new Date(from.getTime() + 14 * DAY_MS);
    default: {
      const months = { MONTHLY: 1, BIMONTHLY: 2, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12 }[freq];
      // Anchor to the day-of-month of the original date; UTC keeps it stable.
      const d = new Date(from);
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + months);
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, lastDay));
      return d;
    }
  }
}

export function issueLabel(seq: number, expectedAt: Date): string {
  return `No. ${seq} (${MONTHS[expectedAt.getUTCMonth()]} ${expectedAt.getUTCFullYear()})`;
}

/** Predict `count` issues following (lastSeq, lastExpected). */
export function predictIssues(
  freq: Frequency,
  lastSeq: number,
  lastExpected: Date,
  count: number,
): { seq: number; label: string; expectedAt: Date }[] {
  const out: { seq: number; label: string; expectedAt: Date }[] = [];
  let seq = lastSeq;
  let at = lastExpected;
  for (let i = 0; i < count; i++) {
    seq += 1;
    at = nextExpected(freq, at);
    out.push({ seq, label: issueLabel(seq, at), expectedAt: at });
  }
  return out;
}

export function isLate(issue: { status: string; expectedAt: Date }, now = new Date()): boolean {
  return issue.status === "EXPECTED" && now.getTime() - issue.expectedAt.getTime() > GRACE_DAYS * DAY_MS;
}
