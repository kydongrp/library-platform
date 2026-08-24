import { requireAdminView } from "@/lib/admin-guard";
import { prisma } from "@/lib/db";
import { startOfZonedMonth } from "@/lib/tz";
import { Card, Badge } from "@/components/ui";
import {
  BarChart, ColumnChart, StatTiles, STATUS_COLORS, CHART_SERIES,
  trailingMonths, bucketByMonth,
} from "@/components/charts";
import { formatDate } from "@/lib/format";
import { DashboardTabs, DashboardHeading } from "../tabs";

export const dynamic = "force-dynamic";

const CHANNEL_LABELS: Record<string, string> = {
  FORMSG: "form.sg",
  WHATSAPP: "WhatsApp",
  OTHER: "Other",
};

export default async function PortalDashboard() {
  await requireAdminView("REPORTS");
  const { keys, labels } = trailingMonths(12);
  const since = startOfZonedMonth(new Date(), -(keys.length - 1));

  const [requests, reqByStatus, reviews, ratingSpread, nominations, nomByChannel, apiClients, webhooks, deliveries] =
    await Promise.all([
      prisma.resourceRequest.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      prisma.resourceRequest.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.review.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      prisma.review.groupBy({ by: ["rating"], _count: { _all: true } }),
      prisma.epSubmission.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      prisma.epSubmission.groupBy({ by: ["channel"], _count: { _all: true } }),
      prisma.apiClient.findMany({ select: { name: true, status: true, lastUsedAt: true } }),
      prisma.webhook.count({ where: { status: "ACTIVE" } }),
      prisma.webhookDelivery.groupBy({ by: ["ok"], _count: { _all: true } }),
    ]);

  const delivered = deliveries.find((d) => d.ok)?._count._all ?? 0;
  const failed = deliveries.find((d) => !d.ok)?._count._all ?? 0;
  const activeKeys = apiClients.filter((c) => c.status === "ACTIVE");

  return (
    <div className="mx-auto max-w-6xl">
      <DashboardHeading
        title="Learner portal dashboard"
        blurb="What learners are sending in through the portal, and the health of the integration that serves it. Requests, reviews and Editor's Pick nominations all originate on the learner side."
      />
      <DashboardTabs active="portal" />

      <StatTiles
        tiles={[
          { label: "Requests, 12 months", value: requests.length },
          { label: "Reviews, 12 months", value: reviews.length },
          { label: "Nominations, 12 months", value: nominations.length },
          {
            label: "Webhook failures",
            value: failed,
            tone: failed > 0 ? "warning" : undefined,
          },
        ]}
      />

      <Card className="mb-6 p-5">
        <ColumnChart
          title="Number of requests"
          subtitle="learner submissions each month, last 12 months"
          labels={labels}
          series={[
            { name: "Resource requests", values: bucketByMonth(requests, (r) => r.createdAt, keys) },
            { name: "Reviews", values: bucketByMonth(reviews, (r) => r.createdAt, keys) },
            { name: "Pick nominations", values: bucketByMonth(nominations, (r) => r.createdAt, keys) },
          ]}
        />
      </Card>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <BarChart
            title="Requests by status"
            subtitle="all time"
            data={reqByStatus
              .map((s) => ({
                label: s.status.charAt(0) + s.status.slice(1).toLowerCase(),
                value: s._count._all,
                color:
                  s.status === "APPROVED" ? STATUS_COLORS.good
                  : s.status === "REJECTED" ? STATUS_COLORS.critical
                  : s.status === "PENDING" ? STATUS_COLORS.warning
                  : CHART_SERIES[2],
              }))
              .sort((a, b) => b.value - a.value)}
            emptyLabel="No requests submitted yet."
          />
        </Card>

        <Card className="p-5">
          <BarChart
            title="Rating spread"
            subtitle="every review on record"
            data={[5, 4, 3, 2, 1].map((star) => ({
              label: `${star} star${star === 1 ? "" : "s"}`,
              value: ratingSpread.find((r) => r.rating === star)?._count._all ?? 0,
              // One measure, so a single hue running light to dark by rating.
              color: ["#0f766e", "#0d9488", "#2dd4bf", "#5eead4", "#99f6e4"][5 - star],
            }))}
            emptyLabel="No reviews yet."
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Four stars and above is the threshold the portal uses to surface a title.
          </p>
        </Card>

        <Card className="p-5">
          <BarChart
            title="Nominations by channel"
            subtitle="how learners submitted them"
            data={nomByChannel
              .map((c) => ({
                label: CHANNEL_LABELS[c.channel] ?? c.channel,
                value: c._count._all,
              }))
              .sort((a, b) => b.value - a.value)}
            emptyLabel="No nominations recorded yet."
          />
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 font-display text-base font-semibold">Portal integration</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            The API keys and webhooks the portal uses to read from and listen to this system.
          </p>
          <ul className="divide-y divide-border">
            <li className="flex items-center justify-between py-2 text-sm">
              <span>Active API keys</span>
              <span className="flex items-center gap-2">
                {activeKeys.length === 0 ? (
                  <Badge tone="muted">none issued</Badge>
                ) : (
                  <Badge tone="success">{activeKeys.length}</Badge>
                )}
              </span>
            </li>
            <li className="flex items-center justify-between py-2 text-sm">
              <span>Active webhooks</span>
              {webhooks === 0 ? <Badge tone="muted">none</Badge> : <Badge tone="success">{webhooks}</Badge>}
            </li>
            <li className="flex items-center justify-between py-2 text-sm">
              <span>Deliveries succeeded</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{delivered.toLocaleString()}</span>
            </li>
            <li className="flex items-center justify-between py-2 text-sm">
              <span>Deliveries failed</span>
              <span
                style={{ fontVariantNumeric: "tabular-nums", color: failed > 0 ? STATUS_COLORS.critical : undefined }}
              >
                {failed.toLocaleString()}
              </span>
            </li>
          </ul>
          {activeKeys.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Last call:{" "}
              {activeKeys.some((k) => k.lastUsedAt)
                ? formatDate(
                    activeKeys
                      .map((k) => k.lastUsedAt)
                      .filter((d): d is Date => !!d)
                      .sort((a, b) => b.getTime() - a.getTime())[0],
                  )
                : "never"}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
