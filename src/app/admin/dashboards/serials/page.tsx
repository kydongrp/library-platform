import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import {
  ColumnChart, StatTiles, STATUS_COLORS, BarChart,
  trailingMonths, bucketByMonth,
} from "@/components/charts";
import { getSerialsOverview, FREQUENCY_LABELS, type Frequency } from "@/lib/serials";
import { getEresourceOverview } from "@/lib/eresources";
import { formatDate } from "@/lib/format";
import { DashboardTabs, DashboardHeading } from "../tabs";

export const dynamic = "force-dynamic";

export default async function SerialsDashboard() {
  await requireAdminView("REPORTS");
  const { keys, labels } = trailingMonths(12);
  const since = new Date(`${keys[0]}-01T00:00:00Z`);

  const [serials, eresources, received, expected] = await Promise.all([
    getSerialsOverview(),
    getEresourceOverview(),
    prisma.serialIssue.findMany({
      where: { status: "RECEIVED", receivedAt: { gte: since } },
      select: { receivedAt: true },
    }),
    prisma.serialIssue.findMany({
      where: { status: "EXPECTED", expectedAt: { gte: since } },
      select: { expectedAt: true },
    }),
  ]);

  const byFrequency = new Map<string, number>();
  for (const s of serials.serials) {
    const k = FREQUENCY_LABELS[s.frequency as Frequency] ?? s.frequency;
    byFrequency.set(k, (byFrequency.get(k) ?? 0) + 1);
  }

  // Subscription expiration: the renewal dates on the e-resource registry,
  // soonest first, which is the same question the live dashboard answers.
  const renewals = eresources.subs.slice(0, 8);
  const lateSerials = serials.serials.filter((s) => s.lateIssues.length > 0);

  return (
    <div className="mx-auto max-w-6xl">
      <DashboardHeading
        title="Serials dashboard"
        blurb="Issue arrivals against what was expected, which subscriptions expire next, and what needs claiming."
      />
      <DashboardTabs active="serials" />

      <StatTiles
        tiles={[
          { label: "Serials tracked", value: serials.serials.length },
          { label: "Active", value: serials.totalActive },
          {
            label: "Late issues",
            value: serials.lateTotal,
            tone: serials.lateTotal > 0 ? "critical" : undefined,
          },
          { label: "Claims sent, 30 days", value: serials.claims30 },
        ]}
      />

      <Card className="mb-6 p-5">
        <ColumnChart
          title="Issues received against expected"
          subtitle="last 12 months"
          labels={labels}
          series={[
            { name: "Received", values: bucketByMonth(received, (i) => i.receivedAt, keys) },
            { name: "Still expected", values: bucketByMonth(expected, (i) => i.expectedAt, keys) },
          ]}
        />
      </Card>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        {/* Table one: subscription expiration */}
        <Card className="p-5">
          <h2 className="mb-1 font-display text-base font-semibold">Subscription expiration</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Soonest renewal first, from the e-resource registry.
          </p>
          {renewals.length === 0 ? (
            <EmptyState title="No subscriptions registered" description="Register providers under E-Resources." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-2 py-1.5 font-medium">Provider</th>
                    <th className="px-2 py-1.5 font-medium">Renews</th>
                    <th className="px-2 py-1.5 text-right font-medium">Days</th>
                  </tr>
                </thead>
                <tbody>
                  {renewals.map((s) => (
                    <tr key={s.id} className="border-b border-border last:border-0">
                      <td className="px-2 py-1.5">{s.provider}</td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground">{formatDate(s.renewalDate)}</td>
                      <td className="px-2 py-1.5 text-right" style={{ fontVariantNumeric: "tabular-nums" }}>
                        {s.status === "OVERDUE" ? (
                          <Badge tone="danger">{-s.daysLeft}d overdue</Badge>
                        ) : s.status === "DUE_SOON" ? (
                          <Badge tone="accent">{s.daysLeft}d</Badge>
                        ) : (
                          <span className="text-muted-foreground">{s.daysLeft}d</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Table two: what needs claiming */}
        <Card className="p-5">
          <h2 className="mb-1 font-display text-base font-semibold">Issues to claim</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Past the grace period. The nightly job claims each of these once.
          </p>
          {lateSerials.length === 0 ? (
            <p className="py-4 text-sm" style={{ color: STATUS_COLORS.good }}>
              Every expected issue has arrived on time.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {lateSerials.slice(0, 8).map((s) => (
                <li key={s.id} className="py-2">
                  <Link href="/admin/serials" className="text-sm font-medium hover:underline">
                    {s.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {s.lateIssues.length} late ·{" "}
                    {s.lateIssues
                      .slice(0, 2)
                      .map((i) => `${i.label} (${i.daysLate}d)`)
                      .join(", ")}
                    {s.lateIssues.length > 2 ? ", …" : ""}
                    {!s.claimEmail && " · no vendor contact"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="p-5">
        <BarChart
          title="Serials by publication pattern"
          data={[...byFrequency.entries()]
            .map(([label, value]) => ({ label, value }))
            .sort((a, b) => b.value - a.value)}
          emptyLabel="No serials registered yet."
        />
      </Card>
    </div>
  );
}
