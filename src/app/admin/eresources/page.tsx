import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { Card, Badge, EmptyState } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { deleteSubscription } from "@/app/actions/eresources";
import {
  getEresourceOverview,
  DUE_SOON_DAYS,
  type SubscriptionRow,
  type SubscriptionStatus,
} from "@/lib/eresources";
import { PROVIDERS } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import {
  SubscriptionForm,
  UsageUploadForm,
  ManualUsageForm,
  type SubFormValues,
} from "./widgets";

export const dynamic = "force-dynamic";

// Semantic status treatment: icon + label + colour, never colour alone.
const STATUS: Record<SubscriptionStatus, { label: string; icon: string; pill: string }> = {
  ACTIVE: { label: "Active", icon: "✓", pill: "bg-green-50 text-green-800 ring-green-200" },
  DUE_SOON: { label: "Due soon", icon: "⚠", pill: "bg-amber-50 text-amber-800 ring-amber-200" },
  OVERDUE: { label: "Overdue", icon: "✕", pill: "bg-red-50 text-red-700 ring-red-200" },
};

function StatusPill({ status }: { status: SubscriptionStatus }) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${s.pill}`}>
      {s.icon} {s.label}
    </span>
  );
}

function money(cents: number, currency: string, decimals = 0): string {
  try {
    return new Intl.NumberFormat("en-SG", {
      style: "currency",
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toLocaleString("en-SG")}`;
  }
}

function costPerUseLabel(r: SubscriptionRow): string {
  if (r.annualCostCents == null) return "no cost set";
  if (r.usage12 === 0) return "no usage data";
  return "";
}

/** 12-month usage mini bar chart (single series — the row names it). */
function Sparkline({ row }: { row: SubscriptionRow }) {
  const BAR = 7, GAP = 2, H = 26;
  const width = row.monthly.length * (BAR + GAP) - GAP;
  const max = Math.max(...row.monthly.map((m) => m.count), 1);
  return (
    <svg
      width={width}
      height={H}
      role="img"
      aria-label={`${row.provider} monthly item requests, trailing 12 months`}
      className="shrink-0"
    >
      {row.monthly.map((m, i) => {
        const h = m.count > 0 ? Math.max(2, Math.round((m.count / max) * (H - 2))) : 0;
        return (
          <g key={m.period}>
            {/* zero months keep a baseline tick so gaps in the data stay visible */}
            <rect
              x={i * (BAR + GAP)}
              y={m.count > 0 ? H - h : H - 1.5}
              width={BAR}
              height={m.count > 0 ? h : 1.5}
              rx={1}
              fill={m.count > 0 ? "#0d9488" : "#d6d3d1"}
            >
              <title>{`${m.period}: ${m.count.toLocaleString()} requests`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

export default async function EresourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const admin = await requireAdminView("CATALOGUE");
  const editable = canEdit(admin, "CATALOGUE");
  const { edit } = await searchParams;

  const overview = await getEresourceOverview();
  const { subs, unregistered, spendByCurrency } = overview;

  const editingSub = edit ? subs.find((s) => s.id === edit) ?? null : null;
  const editing: SubFormValues | null = editingSub
    ? {
        id: editingSub.id,
        provider: editingSub.provider,
        renewalDate: editingSub.renewalDate.toISOString().slice(0, 10),
        startDate: editingSub.startDate?.toISOString().slice(0, 10) ?? "",
        autoRenews: editingSub.autoRenews,
        annualCost: editingSub.annualCostCents != null ? (editingSub.annualCostCents / 100).toFixed(2) : "",
        currency: editingSub.currency,
        seats: editingSub.seats?.toString() ?? "",
        notes: editingSub.notes ?? "",
      }
    : null;

  const providerOptions = [...new Set([
    ...subs.map((s) => s.provider),
    ...unregistered.map((u) => u.provider),
    ...PROVIDERS,
  ])].sort();

  const spendLabel = spendByCurrency.length
    ? spendByCurrency.map(([cur, cents]) => money(cents, cur)).join(" + ")
    : "—";

  const tiles = [
    { label: "Subscriptions", value: String(subs.length), alert: false },
    { label: `Due within ${DUE_SOON_DAYS} days`, value: String(overview.dueSoon), alert: overview.dueSoon > 0 },
    { label: "Overdue", value: String(overview.overdue), alert: overview.overdue > 0 },
    { label: "Annual spend", value: spendLabel, alert: false },
  ];

  const upcoming = subs.filter((s) => s.daysLeft <= 90);

  return (
    <div className="mx-auto max-w-6xl">
      {/* Shared provider suggestions for every form on the page */}
      <datalist id="provider-options">
        {providerOptions.map((p) => <option key={p} value={p} />)}
      </datalist>

      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">E-Resources</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          The subscription registry behind every provider link in the catalogue:
          licence terms, seats, and renewal dates, joined with COUNTER
          (Counting Online Usage of Networked Electronic Resources) usage to give
          each renewal a cost-per-use figure. Renewal alerts email all
          administrators nightly from {DUE_SOON_DAYS} days out, repeating every
          20 days until the renewal is resolved.
        </p>
      </div>

      {/* Summary tiles */}
      <dl className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">{t.label}</dt>
            <dd
              className={`mt-1 font-display text-2xl font-semibold ${t.alert ? "text-red-700" : ""}`}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {t.value}
            </dd>
          </div>
        ))}
      </dl>

      {/* Renewal runway: everything landing in the next 90 days */}
      {upcoming.length > 0 && (
        <Card className="mb-6 border-amber-200 p-5">
          <h2 className="mb-2 font-display text-lg font-semibold">Renewals in the next 90 days</h2>
          <div className="flex flex-wrap gap-2">
            {upcoming.map((s) => (
              <span
                key={s.id}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${STATUS[s.status].pill}`}
              >
                {STATUS[s.status].icon} {s.provider}
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  {s.daysLeft < 0
                    ? `${-s.daysLeft}d overdue`
                    : s.daysLeft === 0
                      ? "due today"
                      : `${s.daysLeft}d left`}
                </span>
                {s.autoRenews && <span title="Auto-renews">↻</span>}
              </span>
            ))}
          </div>
        </Card>
      )}

      {/* Subscription registry with cost-per-use */}
      <Card className="overflow-hidden p-0">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-display text-lg font-semibold">Subscription registry</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Most urgent renewal first. Cost per use = annual cost ÷ item requests
            (COUNTER Total_Item_Requests) over the trailing 12 months.
          </p>
        </div>
        {subs.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No subscriptions registered"
              description="Register each provider below to start tracking renewals and cost-per-use."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-2.5 font-medium">Provider</th>
                  <th className="px-5 py-2.5 font-medium">Renewal</th>
                  <th className="px-5 py-2.5 text-right font-medium">Annual cost</th>
                  <th className="px-5 py-2.5 text-right font-medium">Seats</th>
                  <th className="px-5 py-2.5 text-right font-medium">Titles</th>
                  <th className="px-5 py-2.5 font-medium">Usage · 12 months</th>
                  <th className="px-5 py-2.5 text-right font-medium">Cost / use</th>
                  {editable && <th className="px-5 py-2.5 font-medium"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {subs.map((s) => (
                  <tr key={s.id} className="border-b border-border last:border-0">
                    <td className="px-5 py-3">
                      <p className="font-medium">{s.provider}</p>
                      {s.autoRenews && <p className="text-xs text-muted-foreground">↻ auto-renews</p>}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-col gap-1">
                        <StatusPill status={s.status} />
                        <span className="text-xs text-muted-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
                          {formatDate(s.renewalDate)} ·{" "}
                          {s.daysLeft < 0 ? `${-s.daysLeft}d overdue` : `${s.daysLeft}d left`}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {s.annualCostCents != null ? money(s.annualCostCents, s.currency) : "—"}
                    </td>
                    <td className="px-5 py-3 text-right" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {s.seats ?? "—"}
                    </td>
                    <td className="px-5 py-3 text-right" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {s.titles > 0 ? (
                        <Link
                          href={`/admin/catalogue?source=${encodeURIComponent(s.provider)}`}
                          className="hover:underline"
                        >
                          {s.titles.toLocaleString()}
                        </Link>
                      ) : "0"}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <Sparkline row={s} />
                        <span className="text-xs text-muted-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
                          {s.usage12.toLocaleString()}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {s.costPerUse != null ? (
                        <span className="font-medium">
                          {money(Math.round(s.costPerUse * 100), s.currency, s.costPerUse < 100 ? 2 : 0)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">{costPerUseLabel(s)}</span>
                      )}
                    </td>
                    {editable && (
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <Link
                            href={`/admin/eresources?edit=${s.id}#subscription-form`}
                            className="text-xs text-primary hover:underline"
                          >
                            Edit
                          </Link>
                          <ActionButton
                            action={deleteSubscription}
                            fields={{ id: s.id }}
                            variant="ghost"
                            className="!px-2 !py-1 text-xs text-red-700"
                            pendingLabel="…"
                            confirm={`Remove the ${s.provider} subscription? Usage history is kept.`}
                          >
                            Remove
                          </ActionButton>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Providers in the catalogue with no subscription record */}
      {unregistered.length > 0 && (
        <Card className="mt-6 p-5">
          <h2 className="mb-1 font-display text-lg font-semibold">Not yet registered</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            These providers appear on catalogue records but have no subscription
            entry — no renewal tracking, no cost-per-use.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {unregistered.map((u) => (
              <Badge key={u.provider} tone="neutral">
                {u.provider} · {u.titles.toLocaleString()} title{u.titles === 1 ? "" : "s"}
              </Badge>
            ))}
          </div>
        </Card>
      )}

      {editable && (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {/* Register / edit */}
          <div id="subscription-form">
          <Card className="p-5">
            <h2 className="mb-1 font-display text-lg font-semibold">
              {editing ? `Edit: ${editing.provider}` : "Register a subscription"}
            </h2>
            <p className="mb-4 text-xs text-muted-foreground">
              One entry per provider. The renewal date drives the nightly alert emails.
            </p>
            <SubscriptionForm editing={editing} />
          </Card>
          </div>

          <div className="grid gap-6">
            {/* COUNTER ingest */}
            <Card className="p-5">
              <h2 className="mb-1 font-display text-lg font-semibold">Import COUNTER usage</h2>
              <p className="mb-4 text-xs text-muted-foreground">
                Upload a COUNTER R5 / R5.1 report (TR works best) exported from the
                provider's admin portal, or a simple period,count sheet. Re-importing
                a month overwrites it.
              </p>
              <UsageUploadForm />
            </Card>

            {/* Manual month */}
            <Card className="p-5">
              <h2 className="mb-1 font-display text-lg font-semibold">Record a month by hand</h2>
              <p className="mb-4 text-xs text-muted-foreground">
                For providers without COUNTER exports — sets that month's item requests directly.
              </p>
              <ManualUsageForm />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
