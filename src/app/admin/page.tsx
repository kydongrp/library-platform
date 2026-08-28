import { requireAdminView } from "@/lib/admin-guard";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, Badge } from "@/components/ui";
import { formatDate, daysUntil } from "@/lib/format";
import { listCategories } from "@/lib/categories";

export const dynamic = "force-dynamic";

export default async function AdminDashboard() {
  await requireAdminView("DASHBOARD");
  const categories = await listCategories();

  const now = new Date();

  const [
    titleCount,
    availableCopies,
    memberCount,
    activeLoans,
    overdueLoans,
    pendingHolds,
    readyHolds,
    byCategory,
    recentLoans,
  ] = await Promise.all([
    prisma.resource.count(),
    prisma.copy.count({ where: { status: "AVAILABLE" } }),
    prisma.member.count(),
    prisma.loan.count({ where: { status: "ACTIVE" } }),
    prisma.loan.findMany({
      where: { status: "ACTIVE", dueAt: { lt: now } },
      include: { member: true, resource: true },
      orderBy: { dueAt: "asc" },
      take: 6,
    }),
    prisma.reservation.count({ where: { status: "PENDING" } }),
    prisma.reservation.findMany({
      where: { status: "READY" },
      include: { member: true, resource: true },
      orderBy: { readyAt: "asc" },
      take: 6,
    }),
    prisma.resource.groupBy({
      by: ["category"],
      _count: { _all: true },
    }),
    prisma.loan.findMany({
      include: { member: true, resource: true },
      orderBy: { borrowedAt: "desc" },
      take: 6,
    }),
  ]);

  const overdueCount = await prisma.loan.count({
    where: { status: "ACTIVE", dueAt: { lt: now } },
  });

  const kpis = [
    { label: "Active loans", value: activeLoans, href: "/admin/loans", tone: "primary" as const },
    { label: "Overdue", value: overdueCount, href: "/admin/loans", tone: overdueCount ? "danger" : "muted" as const },
    { label: "Pending holds", value: pendingHolds, href: "/admin/reservations", tone: "accent" as const },
    { label: "Available copies", value: availableCopies, href: "/admin/catalogue", tone: "success" as const },
    { label: "Titles", value: titleCount, href: "/admin/catalogue", tone: "neutral" as const },
    { label: "Members", value: memberCount, href: "/admin/members", tone: "neutral" as const },
  ];

  const catMap = new Map(byCategory.map((c) => [c.category, c._count._all]));
  const maxCat = Math.max(1, ...byCategory.map((c) => c._count._all));

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-7">
        <h1 className="font-display text-3xl font-semibold">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A snapshot of circulation and collection health.
        </p>
      </div>

      {/* The six module dashboards, as the live system splits them. */}
      <div className="mb-6 flex flex-wrap gap-2">
        {[
          ["catalogue", "Catalogue"],
          ["items", "Items"],
          ["loans", "Loans"],
          ["acquisitions", "Purchase orders"],
          ["serials", "Serials"],
          ["portal", "Learner portal"],
        ].map(([slug, label]) => (
          <Link
            key={slug}
            href={`/admin/dashboards/${slug}`}
            className="rounded-full bg-muted px-4 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {label}
          </Link>
        ))}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {kpis.map((k) => (
          <Link key={k.label} href={k.href}>
            <Card className="p-4 transition-shadow hover:shadow-md">
              <p className="text-xs text-muted-foreground">{k.label}</p>
              <p className="mt-1 font-display text-3xl font-semibold">{k.value}</p>
            </Card>
          </Link>
        ))}
      </div>

      <div className="mt-7 grid gap-6 lg:grid-cols-2">
        {/* Overdue */}
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold">Overdue loans</h2>
            <Badge tone={overdueLoans.length ? "danger" : "muted"}>
              {overdueCount} total
            </Badge>
          </div>
          {overdueLoans.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing overdue. 🎉
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {overdueLoans.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{l.resource.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{l.member.name}</p>
                  </div>
                  <Badge tone="danger">{Math.abs(daysUntil(l.dueAt))}d late</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Ready holds */}
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold">Holds ready for pickup</h2>
            <Link href="/admin/reservations" className="text-sm text-primary hover:underline">
              View all
            </Link>
          </div>
          {readyHolds.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No holds waiting for collection.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {readyHolds.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.resource.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{r.member.name}</p>
                  </div>
                  <Badge tone="accent">Ready {formatDate(r.readyAt)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Collection by category */}
        <Card className="p-5">
          <h2 className="mb-4 font-display text-lg font-semibold">Collection by category</h2>
          <ul className="space-y-2.5">
            {categories.map((cat) => {
              const count = catMap.get(cat) ?? 0;
              return (
                <li key={cat} className="flex items-center gap-3">
                  <span className="w-24 shrink-0 text-sm text-muted-foreground">{cat}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(count / maxCat) * 100}%` }}
                    />
                  </div>
                  <span className="w-6 text-right text-sm tabular-nums">{count}</span>
                </li>
              );
            })}
          </ul>
        </Card>

        {/* Recent activity */}
        <Card className="p-5">
          <h2 className="mb-4 font-display text-lg font-semibold">Recent circulation</h2>
          <ul className="divide-y divide-border">
            {recentLoans.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{l.resource.title}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {l.member.name} · {formatDate(l.borrowedAt)}
                  </p>
                </div>
                <Badge tone={l.status === "ACTIVE" ? "primary" : "muted"}>
                  {l.status === "ACTIVE" ? "On loan" : "Returned"}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
