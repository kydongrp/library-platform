import { requireAdminView } from "@/lib/admin-guard";
import { prisma } from "@/lib/db";
import { startOfZonedMonth } from "@/lib/tz";
import { Card } from "@/components/ui";
import {
  BarChart, ColumnChart, StatTiles, CHART_SERIES,
  trailingMonths, bucketByMonth,
} from "@/components/charts";
import { RESOURCE_TYPE_LABELS } from "@/lib/constants";
import { DashboardTabs, DashboardHeading } from "../tabs";

export const dynamic = "force-dynamic";

export default async function CatalogueDashboard() {
  await requireAdminView("REPORTS");
  const { keys, labels } = trailingMonths(12);

  const [added, byCategory, byType, byDesignation, byProvider, marcCount, total] =
    await Promise.all([
      prisma.resource.findMany({
        where: { createdAt: { gte: startOfZonedMonth(new Date(), -(keys.length - 1)) } },
        select: { createdAt: true, materialDesignation: true },
      }),
      prisma.resource.groupBy({ by: ["category"], _count: { _all: true } }),
      prisma.resource.groupBy({ by: ["type"], _count: { _all: true } }),
      prisma.resource.groupBy({ by: ["materialDesignation"], _count: { _all: true } }),
      prisma.resource.groupBy({
        by: ["provider"], where: { provider: { not: null } }, _count: { _all: true },
      }),
      prisma.marcField.groupBy({ by: ["resourceId"] }).then((r) => r.length),
      prisma.resource.count(),
    ]);

  // Bib count by date: monthly additions, split by designation so the growth
  // of the serial holdings is visible against monographs.
  const monographs = bucketByMonth(
    added.filter((r) => r.materialDesignation !== "SERIAL"), (r) => r.createdAt, keys,
  );
  const serials = bucketByMonth(
    added.filter((r) => r.materialDesignation === "SERIAL"), (r) => r.createdAt, keys,
  );

  const serialCount = byDesignation.find((d) => d.materialDesignation === "SERIAL")?._count._all ?? 0;

  return (
    <div className="mx-auto max-w-6xl">
      <DashboardHeading
        title="Catalogue dashboard"
        blurb="How the bibliographic collection is growing and what it is made of. Every figure is live."
      />
      <DashboardTabs active="catalogue" />

      <StatTiles
        tiles={[
          { label: "Titles", value: total },
          { label: "Serials", value: serialCount },
          { label: "Added last 12 months", value: added.length },
          { label: "With catalogued MARC", value: marcCount },
        ]}
      />

      <Card className="mb-6 p-5">
        <ColumnChart
          title="Bib count by date"
          subtitle="titles added each month, last 12 months"
          labels={labels}
          series={[
            { name: "Monographs", values: monographs },
            { name: "Serials", values: serials },
          ]}
        />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <BarChart
            title="Titles by category"
            subtitle="area of interest"
            data={byCategory
              .map((c) => ({ label: c.category, value: c._count._all }))
              .sort((a, b) => b.value - a.value)}
          />
        </Card>

        <Card className="p-5">
          <BarChart
            title="Titles by format"
            data={byType
              .map((t) => ({
                label: RESOURCE_TYPE_LABELS[t.type] ?? t.type,
                value: t._count._all,
              }))
              .sort((a, b) => b.value - a.value)}
          />
        </Card>

        <Card className="p-5">
          <BarChart
            title="Titles by provider"
            subtitle="external subscriptions only"
            data={byProvider
              .map((p) => ({ label: p.provider ?? "Unknown", value: p._count._all }))
              .sort((a, b) => b.value - a.value)}
            emptyLabel="No provider-sourced titles yet."
          />
        </Card>

        <Card className="p-5">
          <BarChart
            title="Monographs and serials"
            subtitle="bib-level designation"
            data={byDesignation.map((d, i) => ({
              label: d.materialDesignation === "SERIAL" ? "Serial" : "Monograph",
              value: d._count._all,
              color: CHART_SERIES[i],
            }))}
          />
        </Card>
      </div>
    </div>
  );
}
