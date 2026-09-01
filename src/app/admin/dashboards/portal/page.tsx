import { requireAdminView } from "@/lib/admin-guard";
import { prisma } from "@/lib/db";
import { startOfZonedMonth } from "@/lib/tz";
import { Card } from "@/components/ui";
import {
  BarChart, ColumnChart, StatTiles, STATUS_COLORS, CHART_SERIES,
  trailingMonths, bucketByMonth,
} from "@/components/charts";
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

  const [requests, reqByStatus, reviews, ratingSpread, nominations, nomByChannel] =
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
    ]);


  return (
    <div className="mx-auto max-w-6xl">
      <DashboardHeading
        title="Learner portal dashboard"
        blurb="What learners are sending in through the portal. Requests, reviews and Editor's Pick nominations all originate on the learner side."
      />
      <DashboardTabs active="portal" />

      <StatTiles
        tiles={[
          { label: "Requests, 12 months", value: requests.length },
          { label: "Reviews, 12 months", value: reviews.length },
          { label: "Nominations, 12 months", value: nominations.length },
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

      </div>
    </div>
  );
}
