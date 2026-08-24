// Staff contribution analytics (CR Tracking): who curated Editor's Picks,
// who decided nominations, and which staff members write reviews — all-time,
// trailing 3 calendar months, and a monthly breakdown. Server-only.
import { LIBRARY_TZ, startOfZonedMonth, zonedMonthKey } from "@/lib/tz";
import { prisma } from "@/lib/db";

export type StaffTotals = {
  name: string;
  epPicks: number; // Editor's Picks curated (attributed on the shelf)
  decisions: number; // nominations approved/rejected
  reviews: number; // reviews written by STAFF members
};

export type MonthRow = {
  key: string; // "2026-08"
  label: string; // "Aug 2026"
  epPicks: number;
  decisions: number;
  reviews: number;
};

export type ContributionData = {
  allTime: StaffTotals[];
  last3Months: StaffTotals[];
  monthly: MonthRow[]; // oldest → newest, last N calendar months
  from3: Date; // start of the trailing-3-month window
};

const MONTHS_SHOWN = 6;

// These were the only bare server-local date reads in the codebase
// (getFullYear/getMonth rather than getUTC*), so on Vercel they bucketed by UTC
// month like everything else, and would have moved again under any TZ change.
function monthStart(d: Date, offsetMonths = 0): Date {
  return startOfZonedMonth(d, offsetMonths);
}

function monthKey(d: Date): string {
  return zonedMonthKey(d);
}

function monthLabel(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: LIBRARY_TZ,
    month: "short",
    year: "numeric",
  }).format(d);
}

type Event = { who: string; at: Date; metric: "epPicks" | "decisions" | "reviews" };

export async function getContributionData(): Promise<ContributionData> {
  const [picks, decisions, staffReviews] = await Promise.all([
    prisma.resource.findMany({
      where: { editorsPick: true, epPickedBy: { not: null } },
      select: { epPickedBy: true, epPickedAt: true },
    }),
    prisma.epSubmission.findMany({
      where: { status: { not: "PENDING" }, decidedBy: { not: null } },
      select: { decidedBy: true, updatedAt: true },
    }),
    prisma.review.findMany({
      where: { member: { memberType: "STAFF" } },
      select: { createdAt: true, member: { select: { name: true } } },
    }),
  ]);

  const events: Event[] = [
    ...picks.map((p) => ({ who: p.epPickedBy!, at: p.epPickedAt ?? new Date(0), metric: "epPicks" as const })),
    ...decisions.map((d) => ({ who: d.decidedBy!, at: d.updatedAt, metric: "decisions" as const })),
    ...staffReviews.map((r) => ({ who: r.member.name, at: r.createdAt, metric: "reviews" as const })),
  ];

  const now = new Date();
  const from3 = monthStart(now, -2); // current month + two before it

  const totalsOf = (filter: (e: Event) => boolean): StaffTotals[] => {
    const by = new Map<string, StaffTotals>();
    for (const e of events) {
      if (!filter(e)) continue;
      const row = by.get(e.who) ?? { name: e.who, epPicks: 0, decisions: 0, reviews: 0 };
      row[e.metric]++;
      by.set(e.who, row);
    }
    return [...by.values()].sort(
      (a, b) => b.epPicks + b.decisions + b.reviews - (a.epPicks + a.decisions + a.reviews),
    );
  };

  const monthly: MonthRow[] = [];
  for (let i = MONTHS_SHOWN - 1; i >= 0; i--) {
    const start = monthStart(now, -i);
    const key = monthKey(start);
    const inMonth = events.filter((e) => monthKey(e.at) === key);
    monthly.push({
      key,
      label: monthLabel(start),
      epPicks: inMonth.filter((e) => e.metric === "epPicks").length,
      decisions: inMonth.filter((e) => e.metric === "decisions").length,
      reviews: inMonth.filter((e) => e.metric === "reviews").length,
    });
  }

  return {
    allTime: totalsOf(() => true),
    last3Months: totalsOf((e) => e.at >= from3),
    monthly,
    from3,
  };
}

/** Long-format rows for the CSV export: month × staff × metric. */
export async function getContributionCsvRows(): Promise<string[][]> {
  const data = await getContributionData();
  const header = ["scope", "staff", "editors_picks", "nominations_decided", "staff_reviews"];
  const rows: string[][] = [header];
  for (const t of data.allTime)
    rows.push(["all_time", t.name, String(t.epPicks), String(t.decisions), String(t.reviews)]);
  for (const t of data.last3Months)
    rows.push(["last_3_months", t.name, String(t.epPicks), String(t.decisions), String(t.reviews)]);
  for (const m of data.monthly)
    rows.push([m.key, "(all staff)", String(m.epPicks), String(m.decisions), String(m.reviews)]);
  return rows;
}
