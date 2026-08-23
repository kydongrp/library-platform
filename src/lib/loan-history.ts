// Past-loan history: the returned-loans query behind /admin/loans/history and
// its CSV export, plus the live-fine rollup for loans still out.

import { prisma } from "@/lib/db";
import { loadCalendar } from "@/lib/calendar";
import { assessFine } from "@/lib/fines";
import { policyFor } from "@/lib/policies";

export type HistoryFilters = {
  q?: string;
  /** "" | ON_TIME | LATE */
  returnStatus?: string;
  /** "" | GOOD | DAMAGED | LOST */
  condition?: string;
  /** "" | outstanding | paid | waived | any */
  fine?: string;
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
  memberId?: string;
};

export type HistoryRow = {
  id: string;
  title: string;
  resourceId: string;
  memberName: string;
  memberId: string;
  barcode: string | null;
  borrowedAt: Date;
  dueAt: Date;
  returnedAt: Date;
  returnStatus: string;
  returnCondition: string;
  returnedBy: string | null;
  renewals: number;
  fineCents: number;
  finePaidAt: Date | null;
  fineWaivedAt: Date | null;
  fineNote: string | null;
};

export type HistoryResult = {
  rows: HistoryRow[];
  total: number;
  totals: {
    late: number;
    finesAssessedCents: number;
    finesOutstandingCents: number;
    finesCollectedCents: number;
    finesWaivedCents: number;
    damagedOrLost: number;
  };
};

const PAGE_SIZE = 100;
export const HISTORY_EXPORT_MAX = 10_000;

/**
 * Filters compose as an AND chain: several of them contribute their own OR
 * (search terms, legacy-null return statuses), which would collide if they
 * all wrote a single top-level `OR` key.
 */
function buildWhere(f: HistoryFilters): Record<string, unknown> {
  const and: Record<string, unknown>[] = [{ status: "RETURNED" }, { returnedAt: { not: null } }];

  if (f.q) {
    and.push({
      OR: [
        { resource: { title: { contains: f.q, mode: "insensitive" } } },
        { member: { name: { contains: f.q, mode: "insensitive" } } },
        { member: { email: { contains: f.q, mode: "insensitive" } } },
      ],
    });
  }
  if (f.memberId) and.push({ memberId: f.memberId });

  // Loans returned before return-tracking shipped are backfilled, but tolerate
  // a null here so a fresh row mid-deploy is still reachable as on-time.
  if (f.returnStatus === "LATE") and.push({ returnStatus: "LATE" });
  else if (f.returnStatus === "ON_TIME")
    and.push({ OR: [{ returnStatus: "ON_TIME" }, { returnStatus: null }] });

  if (f.condition) and.push({ returnCondition: f.condition });

  if (f.fine === "outstanding")
    and.push({ fineCents: { gt: 0 }, finePaidAt: null, fineWaivedAt: null });
  else if (f.fine === "paid") and.push({ finePaidAt: { not: null } });
  else if (f.fine === "waived") and.push({ fineWaivedAt: { not: null } });
  else if (f.fine === "any") and.push({ fineCents: { gt: 0 } });

  const range: Record<string, Date> = {};
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) range.gte = new Date(`${f.from}T00:00:00Z`);
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) range.lte = new Date(`${f.to}T23:59:59Z`);
  if (Object.keys(range).length) and.push({ returnedAt: range });

  return { AND: and };
}

export async function getLoanHistory(
  filters: HistoryFilters,
  page = 1,
  take = PAGE_SIZE,
): Promise<HistoryResult> {
  const where = buildWhere(filters);

  // Totals are aggregated IN THE DATABASE over the whole filtered set. Summing
  // a capped page of rows in JS would silently disagree with `total` once the
  // filter matches more loans than the cap.
  const and = (extra: Record<string, unknown>) => ({ AND: [where, extra] });

  const [loans, total, assessed, outstanding, collected, waived, late, damagedOrLost] =
    await Promise.all([
      prisma.loan.findMany({
        where,
        include: {
          resource: { select: { id: true, title: true } },
          member: { select: { id: true, name: true } },
          copy: { select: { barcode: true } },
        },
        orderBy: { returnedAt: "desc" },
        skip: (Math.max(1, page) - 1) * take,
        take,
      }),
      prisma.loan.count({ where }),
      prisma.loan.aggregate({ where, _sum: { fineCents: true } }),
      prisma.loan.aggregate({
        where: and({ fineCents: { gt: 0 }, finePaidAt: null, fineWaivedAt: null }),
        _sum: { fineCents: true },
      }),
      prisma.loan.aggregate({ where: and({ finePaidAt: { not: null } }), _sum: { fineCents: true } }),
      prisma.loan.aggregate({ where: and({ fineWaivedAt: { not: null } }), _sum: { fineCents: true } }),
      prisma.loan.count({ where: and({ returnStatus: "LATE" }) }),
      prisma.loan.count({ where: and({ returnCondition: { in: ["DAMAGED", "LOST"] } }) }),
    ]);

  const totals = {
    late,
    finesAssessedCents: assessed._sum.fineCents ?? 0,
    finesOutstandingCents: outstanding._sum.fineCents ?? 0,
    finesCollectedCents: collected._sum.fineCents ?? 0,
    finesWaivedCents: waived._sum.fineCents ?? 0,
    damagedOrLost,
  };

  return {
    rows: loans.map((l) => ({
      id: l.id,
      title: l.resource.title,
      resourceId: l.resource.id,
      memberName: l.member.name,
      memberId: l.member.id,
      barcode: l.copy?.barcode ?? null,
      borrowedAt: l.borrowedAt,
      dueAt: l.dueAt,
      returnedAt: l.returnedAt!,
      returnStatus: l.returnStatus ?? (l.returnedAt! > l.dueAt ? "LATE" : "ON_TIME"),
      returnCondition: l.returnCondition ?? "GOOD",
      returnedBy: l.returnedBy,
      renewals: l.renewals,
      fineCents: l.fineCents,
      finePaidAt: l.finePaidAt,
      fineWaivedAt: l.fineWaivedAt,
      fineNote: l.fineNote,
    })),
    total,
    totals,
  };
}

export type LiveOverdue = {
  loanId: string;
  title: string;
  memberName: string;
  memberId: string;
  dueAt: Date;
  accruedCents: number;
  daysLate: number;
};

/**
 * Fines accruing right now on loans that are still out. Computed live against
 * the calendar — nothing is written until the item is checked in.
 */
export async function getAccruingFines(now = new Date()): Promise<LiveOverdue[]> {
  const overdue = await prisma.loan.findMany({
    // Row 51: a claimed return freezes the fine clock. Leaving these in would
    // keep charging a member for an item the library is still looking for,
    // which is the whole thing the claim exists to stop.
    where: { status: "ACTIVE", dueAt: { lt: now }, claimedReturnedAt: null },
    include: {
      resource: { select: { title: true } },
      member: { select: { id: true, name: true, memberType: true } },
    },
    orderBy: { dueAt: "asc" },
  });
  if (overdue.length === 0) return [];

  const cal = await loadCalendar();
  const policyCache = new Map<string, Awaited<ReturnType<typeof policyFor>>>();
  const out: LiveOverdue[] = [];
  for (const loan of overdue) {
    let policy = policyCache.get(loan.member.memberType);
    if (!policy) {
      policy = await policyFor(loan.member.memberType);
      policyCache.set(loan.member.memberType, policy);
    }
    const fine = assessFine(loan.dueAt, now, policy, cal);
    out.push({
      loanId: loan.id,
      title: loan.resource.title,
      memberName: loan.member.name,
      memberId: loan.member.id,
      dueAt: loan.dueAt,
      accruedCents: fine.cents,
      daysLate: fine.daysLate,
    });
  }
  return out;
}
