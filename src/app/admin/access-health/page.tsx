import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { runLinkCheck } from "@/app/actions/batch";
import { getAccessHealth, type ProviderHealth } from "@/lib/linkcheck";
import { NO_VALUE, formatDate, formatTime } from "@/lib/format";

export const dynamic = "force-dynamic";

// Semantic status treatment: icon + label + colour, never colour alone.
const STATUS: Record<
  ProviderHealth["status"],
  { label: string; icon: string; pill: string; bar: string }
> = {
  HEALTHY: { label: "Healthy", icon: "✓", pill: "bg-green-50 text-green-800 ring-green-200", bar: "#15803d" },
  DEGRADED: { label: "Degraded", icon: "⚠", pill: "bg-amber-50 text-amber-800 ring-amber-200", bar: "#b45309" },
  DOWN: { label: "Down", icon: "✕", pill: "bg-red-50 text-red-700 ring-red-200", bar: "#b91c1c" },
};

function StatusPill({ status }: { status: ProviderHealth["status"] }) {
  const s = STATUS[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${s.pill}`}
    >
      {s.icon} {s.label}
    </span>
  );
}

/** Thin health meter: reachable share of the provider's links. */
function HealthMeter({ p }: { p: ProviderHealth }) {
  const pct = Math.round(p.okRatio * 100);
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-2 w-full max-w-44 overflow-hidden rounded-full bg-stone-200"
        role="img"
        aria-label={`${pct}% of ${p.provider} links reachable`}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: STATUS[p.status].bar }}
        />
      </div>
      <span className="text-xs text-muted-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
        {pct}%
      </span>
    </div>
  );
}

export default async function AccessHealthPage() {
  const admin = await requireAdminView("BATCH");
  const editable = canEdit(admin, "BATCH");

  const [health, history] = await Promise.all([
    getAccessHealth(),
    prisma.batchRun.findMany({
      where: { process: "LINKCHECK" },
      orderBy: { ranAt: "desc" },
      take: 6,
    }),
  ]);

  const tiles = [
    { label: "Links monitored", value: health.totalChecked },
    { label: "Reachable", value: health.totalChecked - health.totalBroken },
    { label: "Broken", value: health.totalBroken },
    { label: "Providers", value: health.providers.length },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Access Health</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Every digital access link is scanned nightly (02:00 UTC) and rolled up
            per provider, so a subscription lapse or provider outage shows up here
            before learners report it. When a provider scans as Down, an alert email
            is queued to every administrator.
          </p>
        </div>
        {editable && (
          <ActionButton action={runLinkCheck} fields={{}} pendingLabel="Scanning…">
            ⛓ Scan now
          </ActionButton>
        )}
      </div>

      <p className="mb-4 text-xs text-muted-foreground">
        {health.lastScanAt
          ? `Last scan ${formatDate(health.lastScanAt)} at ${formatTime(health.lastScanAt)} by ${health.lastScanBy ?? "unknown"}.`
          : "No scan has run yet. Run one to populate this page."}
      </p>

      {/* Summary tiles */}
      <dl className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">{t.label}</dt>
            <dd
              className={`mt-1 font-display text-2xl font-semibold ${t.label === "Broken" && t.value > 0 ? "text-red-700" : ""}`}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {t.value}
            </dd>
          </div>
        ))}
      </dl>

      {health.totalChecked === 0 ? (
        <EmptyState
          title="No access data yet"
          description="Run a scan to check every digital access link and build the per-provider picture."
        />
      ) : (
        <>
          {/* Per-provider health */}
          <Card className="overflow-hidden p-0">
            <div className="border-b border-border px-5 py-4">
              <h2 className="font-display text-lg font-semibold">Providers</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Worst first. Down = at least 3 failing links and half the provider&apos;s
                links unreachable. That usually means an outage or a subscription
                problem, not individual titles.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-5 py-2.5 font-medium">Provider</th>
                    <th className="px-5 py-2.5 font-medium">Status</th>
                    <th className="px-5 py-2.5 font-medium">Reachable</th>
                    <th className="px-5 py-2.5 text-right font-medium">Links</th>
                    <th className="px-5 py-2.5 text-right font-medium">Broken</th>
                    <th className="px-5 py-2.5 font-medium">Most common error</th>
                  </tr>
                </thead>
                <tbody>
                  {health.providers.map((p) => (
                    <tr key={p.provider} className="border-b border-border last:border-0">
                      <td className="px-5 py-3 font-medium">{p.provider}</td>
                      <td className="px-5 py-3"><StatusPill status={p.status} /></td>
                      <td className="px-5 py-3"><HealthMeter p={p} /></td>
                      <td className="px-5 py-3 text-right" style={{ fontVariantNumeric: "tabular-nums" }}>{p.checked}</td>
                      <td className={`px-5 py-3 text-right ${p.broken > 0 ? "font-semibold text-red-700" : ""}`} style={{ fontVariantNumeric: "tabular-nums" }}>{p.broken}</td>
                      <td className="px-5 py-3 text-xs text-muted-foreground">{p.sampleError ?? NO_VALUE}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Broken links detail */}
          <Card className="mt-6 p-5">
            <h2 className="mb-1 font-display text-lg font-semibold">Broken links</h2>
            {health.broken.length === 0 ? (
              <p className="py-3 text-sm text-green-700">
                ✓ Every digital access link resolved on the last scan.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {health.broken.map((b) => (
                  <li key={b.resourceId} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <Link
                        href={`/admin/catalogue/${b.resourceId}`}
                        className="truncate text-sm font-medium hover:underline"
                      >
                        {b.title}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">{b.url}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge tone="neutral">{b.provider}</Badge>
                      <Badge tone="danger">{b.error}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Scan history */}
          <Card className="mt-6 p-5">
            <h2 className="mb-3 font-display text-lg font-semibold">Scan history</h2>
            {history.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">No scans recorded.</p>
            ) : (
              <ul className="divide-y divide-border">
                {history.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                    <p className="text-sm">{r.summary}</p>
                    <p className="text-xs text-muted-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {formatDate(r.ranAt)}{" "}
                      {formatTime(r.ranAt)}
                      {" · "}
                      {r.ranBy}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
