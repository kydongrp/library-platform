import { requireAdminView } from "@/lib/admin-guard";
import { prisma } from "@/lib/db";
import { Card } from "@/components/ui";
import {
  BarChart, ColumnChart, StackedBars, StatTiles, STATUS_COLORS, CHART_SERIES,
  trailingMonths, bucketByMonth,
} from "@/components/charts";
import { getAcquisitionsOverview } from "@/lib/acquisitions";
import { DashboardTabs, DashboardHeading } from "../tabs";

export const dynamic = "force-dynamic";

const money = (cents: number) => {
  try {
    return new Intl.NumberFormat("en-SG", {
      style: "currency", currency: "SGD", maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `SGD ${(cents / 100).toLocaleString("en-SG")}`;
  }
};

export default async function AcquisitionsDashboard() {
  await requireAdminView("REPORTS");
  const { keys, labels } = trailingMonths(12);
  const since = new Date(`${keys[0]}-01T00:00:00Z`);

  const [overview, orders, invoices] = await Promise.all([
    getAcquisitionsOverview(),
    prisma.purchaseOrder.findMany({
      where: { orderedAt: { gte: since } },
      select: { orderedAt: true, status: true },
    }),
    prisma.invoice.findMany({
      where: { invoiceDate: { gte: since } },
      include: { supplier: { select: { name: true } } },
    }),
  ]);

  // Budget summary for the current fiscal year: the most recent year on record.
  const currentFy = overview.fiscalYears[0];
  const fyFunds = overview.funds.filter((f) => f.fiscalYear === currentFy);

  const statusCounts = new Map<string, number>();
  for (const o of orders) statusCounts.set(o.status, (statusCounts.get(o.status) ?? 0) + 1);

  const spendBySupplier = new Map<string, number>();
  for (const inv of invoices) {
    if (!inv.paidAt) continue;
    spendBySupplier.set(
      inv.supplier.name,
      (spendBySupplier.get(inv.supplier.name) ?? 0) + inv.amountCents,
    );
  }

  const { budgetCents, committedCents, spentCents, pendingInvoiceCents } = overview.totals;

  return (
    <div className="mx-auto max-w-6xl">
      <DashboardHeading
        title="Purchase orders dashboard"
        blurb="Where the acquisitions budget stands, what is on order, and who it is going to. Committed money is open orders; spent is paid invoices."
      />
      <DashboardTabs active="acquisitions" />

      <StatTiles
        tiles={[
          { label: "Budget", value: money(budgetCents) },
          { label: "Committed", value: money(committedCents) },
          { label: "Spent", value: money(spentCents) },
          {
            label: "Awaiting payment",
            value: money(pendingInvoiceCents),
            tone: pendingInvoiceCents > 0 ? "warning" : undefined,
          },
        ]}
      />

      <Card className="mb-6 p-5">
        <StackedBars
          title={`Budget summary${currentFy ? `, ${currentFy}` : ""}`}
          subtitle="per fund"
          format={money}
          rows={fyFunds.map((f) => ({
            label: f.name,
            note: `${money(f.amountCents)} allocated${f.availableCents < 0 ? " · OVER BUDGET" : ""}`,
            segments: [
              { name: "Spent", value: f.spentCents, color: CHART_SERIES[0] },
              { name: "Committed", value: f.committedCents, color: "#99f6e4" },
              {
                name: "Available",
                value: Math.max(0, f.availableCents),
                color: f.availableCents < 0 ? STATUS_COLORS.critical : "#e7e5e4",
              },
            ],
          }))}
        />
      </Card>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <ColumnChart
            title="Orders raised by month"
            subtitle="last 12 months"
            labels={labels}
            series={[{ name: "Purchase orders", values: bucketByMonth(orders, (o) => o.orderedAt, keys) }]}
          />
        </Card>

        <Card className="p-5">
          <ColumnChart
            title="Invoices received by month"
            subtitle="last 12 months"
            labels={labels}
            series={[{ name: "Invoices", values: bucketByMonth(invoices, (i) => i.invoiceDate, keys) }]}
          />
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <BarChart
            title="Orders by status"
            subtitle="last 12 months"
            data={[
              { label: "Ordered", value: statusCounts.get("ORDERED") ?? 0, color: CHART_SERIES[2] },
              { label: "Received", value: statusCounts.get("RECEIVED") ?? 0, color: STATUS_COLORS.good },
              { label: "Closed", value: statusCounts.get("CLOSED") ?? 0, color: STATUS_COLORS.idle },
              { label: "Cancelled", value: statusCounts.get("CANCELLED") ?? 0, color: STATUS_COLORS.critical },
            ]}
            emptyLabel="No orders raised in this period."
          />
        </Card>

        <Card className="p-5">
          <BarChart
            title="Spend by supplier"
            subtitle="paid invoices, last 12 months"
            data={[...spendBySupplier.entries()]
              .map(([name, cents]) => ({ label: name, value: Math.round(cents / 100), note: money(cents) }))
              .sort((a, b) => b.value - a.value)}
            emptyLabel="No invoices paid in this period."
          />
          <p className="mt-2 text-xs text-muted-foreground">Values in Singapore dollars.</p>
        </Card>
      </div>
    </div>
  );
}
