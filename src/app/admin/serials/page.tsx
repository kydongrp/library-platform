import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import {
  checkInIssue,
  claimIssue,
  skipIssue,
  extendSchedule,
  deleteSerial,
} from "@/app/actions/serials";
import {
  getSerialsOverview,
  FREQUENCY_LABELS,
  GRACE_DAYS,
  type Frequency,
} from "@/lib/serials";
import { formatDate } from "@/lib/format";
import { RegisterSerialForm, EditSerialForm, type SerialEditValues } from "./widgets";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, { label: string; icon: string; pill: string }> = {
  ACTIVE: { label: "Active", icon: "✓", pill: "bg-green-50 text-green-800 ring-green-200" },
  PAUSED: { label: "Paused", icon: "⏸", pill: "bg-amber-50 text-amber-800 ring-amber-200" },
  CLOSED: { label: "Closed", icon: "■", pill: "bg-stone-100 text-stone-600 ring-stone-200" },
};

export default async function SerialsPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const admin = await requireAdminView("CATALOGUE");
  const editable = canEdit(admin, "CATALOGUE");
  const { edit } = await searchParams;

  const [overview, candidates] = await Promise.all([
    getSerialsOverview(),
    prisma.resource.findMany({
      where: { type: { in: ["JOURNAL", "MAGAZINE"] }, serial: null },
      select: { id: true, title: true },
      orderBy: { title: "asc" },
      take: 500,
    }),
  ]);

  const editing: SerialEditValues | null = (() => {
    const s = edit ? overview.serials.find((x) => x.id === edit) : null;
    return s
      ? {
          id: s.id,
          issn: s.issn ?? "",
          frequency: s.frequency,
          status: s.status,
          claimEmail: s.claimEmail ?? "",
          notes: s.notes ?? "",
        }
      : null;
  })();

  const tiles = [
    { label: "Serials tracked", value: overview.serials.length, alert: false },
    { label: "Active", value: overview.totalActive, alert: false },
    { label: "Late issues", value: overview.lateTotal, alert: overview.lateTotal > 0 },
    { label: "Claims sent · 30 days", value: overview.claims30, alert: false },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Serials</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Issue-level control for journal and magazine subscriptions: the
          schedule is predicted from each title&apos;s publication pattern,
          arrivals are checked in with one click, and issues more than{" "}
          {GRACE_DAYS} days overdue are claimed from the vendor automatically
          by the nightly job (or manually here).
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

      {/* Serials list */}
      {overview.serials.length === 0 ? (
        <EmptyState
          title="No serials tracked yet"
          description="Register a journal or magazine below to start predicting and checking in issues."
        />
      ) : (
        <div className="space-y-4">
          {overview.serials.map((s) => (
            <Card key={s.id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/admin/catalogue/${s.resourceId}`} className="font-display text-lg font-semibold hover:underline">
                    {s.title}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_TONE[s.status].pill}`}>
                      {STATUS_TONE[s.status].icon} {STATUS_TONE[s.status].label}
                    </span>
                    <Badge tone="muted">{FREQUENCY_LABELS[s.frequency as Frequency]}</Badge>
                    {s.issn && <Badge tone="neutral">ISSN {s.issn}</Badge>}
                    {s.provider && <Badge tone="neutral">{s.provider}</Badge>}
                    {!s.claimEmail && (
                      <span className="text-xs text-amber-700">no vendor claim contact</span>
                    )}
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Holdings: {s.holdings ?? "nothing received yet"} ·{" "}
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>{s.received}</span> received
                  </p>
                </div>
                {editable && (
                  <div className="flex flex-wrap items-center gap-2">
                    {s.nextIssue && (
                      <ActionButton action={checkInIssue} fields={{ issueId: s.nextIssue.id }}
                        className="!px-3 !py-1.5 text-xs" pendingLabel="Checking in…">
                        ✓ Check in {s.nextIssue.label}
                      </ActionButton>
                    )}
                    <ActionButton action={extendSchedule} fields={{ serialId: s.id }} variant="ghost"
                      className="!px-2 !py-1 text-xs" pendingLabel="…">
                      Extend schedule
                    </ActionButton>
                    <Link href={`/admin/serials?edit=${s.id}#serial-edit`} className="px-1 text-xs text-primary hover:underline">
                      Edit
                    </Link>
                    <ActionButton action={deleteSerial} fields={{ id: s.id }} variant="ghost"
                      className="!px-2 !py-1 text-xs text-red-700" pendingLabel="…"
                      confirm={`Stop tracking "${s.title}"? Its issue history is removed; the catalogue record stays.`}>
                      Untrack
                    </ActionButton>
                  </div>
                )}
              </div>

              {s.nextIssue && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Next expected: <strong>{s.nextIssue.label}</strong> on {formatDate(s.nextIssue.expectedAt)}
                </p>
              )}

              {/* Late issues for this serial */}
              {s.lateIssues.length > 0 && (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50/50 p-3">
                  <p className="mb-2 text-xs font-medium text-red-800">
                    ⚠ {s.lateIssues.length} issue{s.lateIssues.length === 1 ? "" : "s"} late (&gt;{GRACE_DAYS} days past expected)
                  </p>
                  <ul className="space-y-1.5">
                    {s.lateIssues.map((i) => (
                      <li key={i.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm">
                          {i.label} · expected {formatDate(i.expectedAt)} ·{" "}
                          <span className="font-medium text-red-700" style={{ fontVariantNumeric: "tabular-nums" }}>
                            {i.daysLate}d late
                          </span>
                          {i.claimedAt && (
                            <span className="text-xs text-muted-foreground"> · claimed {formatDate(i.claimedAt)}</span>
                          )}
                        </span>
                        {editable && (
                          <span className="flex items-center gap-1.5">
                            <ActionButton action={checkInIssue} fields={{ issueId: i.id }}
                              className="!px-2 !py-1 text-xs" pendingLabel="…">
                              ✓ Arrived
                            </ActionButton>
                            <ActionButton action={claimIssue} fields={{ issueId: i.id }} variant="outline"
                              className="!px-2 !py-1 text-xs" pendingLabel="…">
                              ✉ {i.claimedAt ? "Re-claim" : "Claim"}
                            </ActionButton>
                            <ActionButton action={skipIssue} fields={{ issueId: i.id }} variant="ghost"
                              className="!px-2 !py-1 text-xs" pendingLabel="…"
                              confirm={`Mark ${i.label} as not published? It won't be claimed.`}>
                              Not published
                            </ActionButton>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {editing?.id === s.id && editable && (
                <div id="serial-edit" className="mt-4 border-t border-border pt-4">
                  <EditSerialForm serial={editing} />
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Register */}
        {editable && (
          <Card className="p-5">
            <h2 className="mb-1 font-display text-lg font-semibold">Register a serial</h2>
            <p className="mb-4 text-xs text-muted-foreground">
              Pick a journal or magazine from the catalogue, set its pattern,
              and the first 12 issues are predicted automatically.
              {candidates.length === 0 && " (No untracked journal/magazine titles in the catalogue right now.)"}
            </p>
            <RegisterSerialForm options={candidates} />
          </Card>
        )}

        {/* Recent check-ins */}
        <Card className="p-5">
          <h2 className="mb-3 font-display text-lg font-semibold">Recent check-ins</h2>
          {overview.recentCheckIns.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">Nothing checked in yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {overview.recentCheckIns.map((c, idx) => (
                <li key={idx} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 truncate text-sm">
                    {c.serial} · <strong>{c.label}</strong>
                  </span>
                  <span className="text-xs text-muted-foreground">{formatDate(c.receivedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
