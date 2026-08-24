import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { prisma } from "@/lib/db";
import { startOfZonedMonth } from "@/lib/tz";
import { Card } from "@/components/ui";
import { BarChart, StatTiles, STATUS_COLORS, ColumnChart, trailingMonths, bucketByMonth } from "@/components/charts";
import { COPY_STATUS_LABELS } from "@/lib/constants";
import { DashboardTabs, DashboardHeading } from "../tabs";

export const dynamic = "force-dynamic";

// Circulation state is a status, so it gets the reserved status palette rather
// than series colours, and each bar is labelled in text.
const STATUS_TONE: Record<string, string> = {
  AVAILABLE: STATUS_COLORS.good,
  ON_LOAN: "#0d9488",
  RESERVED: STATUS_COLORS.warning,
  LOST: STATUS_COLORS.critical,
  MAINTENANCE: STATUS_COLORS.idle,
};

export default async function ItemsDashboard() {
  await requireAdminView("REPORTS");
  const { keys, labels } = trailingMonths(12);

  const [byStatus, byCollection, byLocation, byType, added, weeded, total, unclassified] =
    await Promise.all([
      prisma.copy.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.itemCollection.findMany({
        select: { code: true, name: true, _count: { select: { copies: true } } },
      }),
      prisma.itemLocation.findMany({
        select: { code: true, name: true, _count: { select: { copies: true } } },
      }),
      prisma.itemType.findMany({
        select: { code: true, name: true, loanable: true, _count: { select: { copies: true } } },
      }),
      prisma.copy.findMany({
        where: { createdAt: { gte: startOfZonedMonth(new Date(), -(keys.length - 1)) } },
        select: { createdAt: true },
      }),
      prisma.itemWeedLog.findMany({
        where: { weededAt: { gte: startOfZonedMonth(new Date(), -(keys.length - 1)) } },
        select: { weededAt: true },
      }),
      prisma.copy.count(),
      prisma.copy.count({ where: { collectionId: null } }),
    ]);

  const outOfCirculation = byStatus
    .filter((s) => s.status === "LOST" || s.status === "MAINTENANCE")
    .reduce((n, s) => n + s._count._all, 0);

  return (
    <div className="mx-auto max-w-6xl">
      <DashboardHeading
        title="Items dashboard"
        blurb="The physical holdings: where copies are, what they are, and what has left the collection."
      />
      <DashboardTabs active="items" />

      <StatTiles
        tiles={[
          { label: "Items", value: total },
          { label: "Out of circulation", value: outOfCirculation, tone: outOfCirculation > 0 ? "warning" : undefined },
          { label: "Added last 12 months", value: added.length },
          { label: "Weeded last 12 months", value: weeded.length },
        ]}
      />

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <BarChart
            title="Items by status"
            subtitle="circulation state"
            data={byStatus
              .map((s) => ({
                label: COPY_STATUS_LABELS[s.status] ?? s.status,
                value: s._count._all,
                color: STATUS_TONE[s.status] ?? STATUS_COLORS.idle,
              }))
              .sort((a, b) => b.value - a.value)}
          />
        </Card>

        <Card className="p-5">
          <ColumnChart
            title="Items added and weeded"
            subtitle="last 12 months"
            labels={labels}
            series={[
              { name: "Added", values: bucketByMonth(added, (r) => r.createdAt, keys) },
              { name: "Weeded", values: bucketByMonth(weeded, (r) => r.weededAt, keys) },
            ]}
          />
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="p-5">
          <BarChart
            title="By collection"
            data={byCollection
              .map((c) => ({ label: c.code, value: c._count.copies, note: c.name }))
              .sort((a, b) => b.value - a.value)}
            emptyLabel="No collections defined yet."
          />
          {unclassified > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              <Link href="/admin/items" className="text-primary hover:underline">
                {unclassified.toLocaleString()} item{unclassified === 1 ? "" : "s"}
              </Link>{" "}
              have no collection assigned.
            </p>
          )}
        </Card>

        <Card className="p-5">
          <BarChart
            title="By location"
            data={byLocation
              .map((l) => ({ label: l.code, value: l._count.copies, note: l.name }))
              .sort((a, b) => b.value - a.value)}
            emptyLabel="No locations defined yet."
          />
        </Card>

        <Card className="p-5">
          <BarChart
            title="By item type"
            data={byType
              .map((t) => ({
                label: t.code,
                value: t._count.copies,
                note: t.loanable ? t.name : `${t.name} (reference only)`,
                color: t.loanable ? undefined : STATUS_COLORS.idle,
              }))
              .sort((a, b) => b.value - a.value)}
            emptyLabel="No item types defined yet."
          />
        </Card>
      </div>
    </div>
  );
}
