import { requireAdminView } from "@/lib/admin-guard";
import { prisma } from "@/lib/db";
import { startOfZonedMonth } from "@/lib/tz";
import { Card } from "@/components/ui";
import {
  BarChart, ColumnChart, StatTiles, STATUS_COLORS,
  trailingMonths, bucketByMonth,
} from "@/components/charts";
import { MEMBER_TYPE_LABELS } from "@/lib/constants";
import { formatFine } from "@/lib/fines";
import { DashboardTabs, DashboardHeading } from "../tabs";

export const dynamic = "force-dynamic";

export default async function LoansDashboard() {
  await requireAdminView("REPORTS");
  const { keys, labels } = trailingMonths(12);
  const since = startOfZonedMonth(new Date(), -(keys.length - 1));
  const now = new Date();

  const [period, byMemberType, active, overdue, returnedStats, fineAgg, outstandingAgg, topTitles] =
    await Promise.all([
      prisma.loan.findMany({
        where: { OR: [{ borrowedAt: { gte: since } }, { returnedAt: { gte: since } }] },
        select: { borrowedAt: true, returnedAt: true },
      }),
      prisma.loan.groupBy({
        by: ["memberId"], where: { borrowedAt: { gte: since } }, _count: { _all: true },
      }),
      prisma.loan.count({ where: { status: "ACTIVE" } }),
      prisma.loan.count({ where: { status: "ACTIVE", dueAt: { lt: now } } }),
      prisma.loan.groupBy({
        by: ["returnStatus"], where: { status: "RETURNED" }, _count: { _all: true },
      }),
      prisma.loan.aggregate({ where: { fineCents: { gt: 0 } }, _sum: { fineCents: true } }),
      prisma.loan.aggregate({
        where: { fineCents: { gt: 0 }, finePaidAt: null, fineWaivedAt: null },
        _sum: { fineCents: true },
      }),
      prisma.loan.groupBy({
        by: ["resourceId"], where: { borrowedAt: { gte: since } },
        _count: { _all: true }, orderBy: { _count: { resourceId: "desc" } }, take: 8,
      }),
    ]);

  // Member type needs a second pass: loans group by member, not by type.
  const memberIds = byMemberType.map((m) => m.memberId);
  const members = memberIds.length
    ? await prisma.member.findMany({
        where: { id: { in: memberIds } }, select: { id: true, memberType: true },
      })
    : [];
  const typeOf = new Map(members.map((m) => [m.id, m.memberType]));
  const perType = new Map<string, number>();
  for (const row of byMemberType) {
    const t = typeOf.get(row.memberId) ?? "UNKNOWN";
    perType.set(t, (perType.get(t) ?? 0) + row._count._all);
  }

  const titles = topTitles.length
    ? await prisma.resource.findMany({
        where: { id: { in: topTitles.map((t) => t.resourceId) } },
        select: { id: true, title: true },
      })
    : [];
  const titleOf = new Map(titles.map((t) => [t.id, t.title]));

  const late = returnedStats.find((s) => s.returnStatus === "LATE")?._count._all ?? 0;
  const onTime = returnedStats
    .filter((s) => s.returnStatus !== "LATE")
    .reduce((n, s) => n + s._count._all, 0);

  return (
    <div className="mx-auto max-w-6xl">
      <DashboardHeading
        title="Loans dashboard"
        blurb="Circulation volume, how items come back, and what is owed. Overdue counts and fines are live."
      />
      <DashboardTabs active="loans" />

      <StatTiles
        tiles={[
          { label: "On loan now", value: active },
          { label: "Overdue now", value: overdue, tone: overdue > 0 ? "critical" : undefined },
          { label: "Fines assessed", value: formatFine(fineAgg._sum.fineCents ?? 0) },
          {
            label: "Fines outstanding",
            value: formatFine(outstandingAgg._sum.fineCents ?? 0),
            tone: (outstandingAgg._sum.fineCents ?? 0) > 0 ? "warning" : undefined,
          },
        ]}
      />

      <Card className="mb-6 p-5">
        <ColumnChart
          title="Loans by month"
          subtitle="borrowed against returned, last 12 months"
          labels={labels}
          series={[
            { name: "Borrowed", values: bucketByMonth(period, (l) => l.borrowedAt, keys) },
            { name: "Returned", values: bucketByMonth(period, (l) => l.returnedAt, keys) },
          ]}
        />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <BarChart
            title="How items came back"
            subtitle="every returned loan"
            data={[
              { label: "On time", value: onTime, color: STATUS_COLORS.good },
              { label: "Late", value: late, color: STATUS_COLORS.critical },
            ]}
          />
        </Card>

        <Card className="p-5">
          <BarChart
            title="Loans by member type"
            subtitle="last 12 months"
            data={[...perType.entries()]
              .map(([t, v]) => ({ label: MEMBER_TYPE_LABELS[t] ?? t, value: v }))
              .sort((a, b) => b.value - a.value)}
          />
        </Card>

        <Card className="p-5 lg:col-span-2">
          <BarChart
            title="Most borrowed titles"
            subtitle="last 12 months"
            data={topTitles.map((t) => ({
              label: titleOf.get(t.resourceId) ?? "Unknown title",
              value: t._count._all,
            }))}
          />
        </Card>
      </div>
    </div>
  );
}
