import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { Card, Badge, EmptyState, ButtonLink } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { payFine, waiveFine } from "@/app/actions/circulation";
import { getLoanHistory } from "@/lib/loan-history";
import { formatFine } from "@/lib/fines";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

const CONDITION_TONE: Record<string, { label: string; icon: string; tone: "success" | "accent" | "danger" }> = {
  GOOD: { label: "Good", icon: "✓", tone: "success" },
  DAMAGED: { label: "Damaged", icon: "⚠", tone: "accent" },
  LOST: { label: "Lost", icon: "✕", tone: "danger" },
};

type SearchParams = Promise<{
  q?: string; returnStatus?: string; condition?: string; fine?: string;
  from?: string; to?: string; page?: string;
}>;

export default async function LoanHistoryPage({ searchParams }: { searchParams: SearchParams }) {
  const admin = await requireAdminView("LOANS");
  const editable = canEdit(admin, "LOANS");

  const sp = await searchParams;
  const filters = {
    q: (sp.q ?? "").trim(),
    returnStatus: sp.returnStatus ?? "",
    condition: sp.condition ?? "",
    fine: sp.fine ?? "",
    from: sp.from ?? "",
    to: sp.to ?? "",
  };
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { rows, total, totals } = await getLoanHistory(filters, page, PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const qs = new URLSearchParams(
    Object.entries(filters).filter(([, v]) => v) as [string, string][],
  );
  const pageHref = (p: number) => {
    const u = new URLSearchParams(qs);
    u.set("page", String(p));
    return `/admin/loans/history?${u}`;
  };

  const inputCls =
    "rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

  const tiles = [
    { label: "Loans returned", value: total.toLocaleString(), alert: false },
    { label: "Returned late", value: totals.late.toLocaleString(), alert: totals.late > 0 },
    { label: "Fines outstanding", value: formatFine(totals.finesOutstandingCents), alert: totals.finesOutstandingCents > 0 },
    { label: "Fines collected", value: formatFine(totals.finesCollectedCents), alert: false },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Loan History</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Every returned loan, with how it came back and what it cost. Fines
            are charged per day the library was open, so closures are never
            billed — a loan can be late with nothing owed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ButtonLink href="/admin/loans" variant="outline">↻ Current loans</ButtonLink>
          <ButtonLink href={`/admin/loans/history/export?${qs}`} variant="ghost" className="text-xs">
            ⇑ Export CSV
          </ButtonLink>
        </div>
      </div>

      <dl className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">{t.label}</dt>
            <dd className={`mt-1 font-display text-xl font-semibold ${t.alert ? "text-amber-700" : ""}`}
              style={{ fontVariantNumeric: "tabular-nums" }}>
              {t.value}
            </dd>
          </div>
        ))}
      </dl>

      {/* Filters */}
      <form className="mb-4 flex flex-wrap items-end gap-2">
        <input name="q" defaultValue={filters.q} placeholder="Title, member, email…"
          className={`min-w-52 flex-1 ${inputCls}`} aria-label="Search" />
        <select name="returnStatus" defaultValue={filters.returnStatus} className={inputCls} aria-label="Return timeliness">
          <option value="">On time &amp; late</option>
          <option value="ON_TIME">On time only</option>
          <option value="LATE">Late only</option>
        </select>
        <select name="condition" defaultValue={filters.condition} className={inputCls} aria-label="Condition">
          <option value="">Any condition</option>
          <option value="GOOD">Good</option>
          <option value="DAMAGED">Damaged</option>
          <option value="LOST">Lost</option>
        </select>
        <select name="fine" defaultValue={filters.fine} className={inputCls} aria-label="Fine state">
          <option value="">Any fine state</option>
          <option value="any">Fined</option>
          <option value="outstanding">Outstanding</option>
          <option value="paid">Paid</option>
          <option value="waived">Waived</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          from <input type="date" name="from" defaultValue={filters.from} className={inputCls} />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          to <input type="date" name="to" defaultValue={filters.to} className={inputCls} />
        </label>
        <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
          Filter
        </button>
        {Object.values(filters).some(Boolean) && (
          <Link href="/admin/loans/history" className="px-2 py-2 text-sm text-muted-foreground hover:text-foreground">
            Clear
          </Link>
        )}
      </form>

      {rows.length === 0 ? (
        <EmptyState
          title="No returned loans match"
          description="Adjust the filters, or check in an item to start building history."
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Title</th>
                  <th className="px-4 py-2.5 font-medium">Member</th>
                  <th className="px-4 py-2.5 font-medium">Borrowed</th>
                  <th className="px-4 py-2.5 font-medium">Due</th>
                  <th className="px-4 py-2.5 font-medium">Returned</th>
                  <th className="px-4 py-2.5 font-medium">Condition</th>
                  <th className="px-4 py-2.5 text-right font-medium">Fine</th>
                  {editable && <th className="px-4 py-2.5"><span className="sr-only">Settle</span></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const cond = CONDITION_TONE[r.returnCondition] ?? CONDITION_TONE.GOOD;
                  const outstanding = r.fineCents > 0 && !r.finePaidAt && !r.fineWaivedAt;
                  return (
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5">
                        <Link href={`/admin/catalogue/${r.resourceId}`} className="font-medium hover:underline">
                          {r.title}
                        </Link>
                        {r.barcode && <p className="text-xs text-muted-foreground">{r.barcode}</p>}
                      </td>
                      <td className="px-4 py-2.5">
                        <Link href={`/admin/members/${r.memberId}`} className="hover:underline">
                          {r.memberName}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{formatDate(r.borrowedAt)}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{formatDate(r.dueAt)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs">{formatDate(r.returnedAt)}</span>
                          {r.returnStatus === "LATE" ? (
                            <Badge tone="danger">✕ Late</Badge>
                          ) : (
                            <Badge tone="success">✓ On time</Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={cond.tone}>{cond.icon} {cond.label}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-right" style={{ fontVariantNumeric: "tabular-nums" }}>
                        {r.fineCents === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-col items-end gap-0.5">
                            <span className={outstanding ? "font-semibold text-amber-700" : ""}>
                              {formatFine(r.fineCents)}
                            </span>
                            {r.finePaidAt && <Badge tone="success">paid</Badge>}
                            {r.fineWaivedAt && <Badge tone="muted">waived</Badge>}
                          </div>
                        )}
                      </td>
                      {editable && (
                        <td className="px-4 py-2.5">
                          {outstanding && (
                            <div className="flex items-center justify-end gap-1.5">
                              <ActionButton action={payFine} fields={{ loanId: r.id }}
                                className="!px-2 !py-1 text-xs" pendingLabel="…">
                                Mark paid
                              </ActionButton>
                              <ActionButton action={waiveFine} fields={{ loanId: r.id }} variant="ghost"
                                className="!px-2 !py-1 text-xs" pendingLabel="…"
                                confirm={`Waive the ${formatFine(r.fineCents)} fine for ${r.memberName}?`}>
                                Waive
                              </ActionButton>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-muted-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
            Page {page} of {totalPages} · {total.toLocaleString()} loans
          </span>
          <div className="flex gap-2">
            {page > 1 && <Link href={pageHref(page - 1)} className="rounded-lg border border-border px-3 py-1.5 hover:bg-muted">← Newer</Link>}
            {page < totalPages && <Link href={pageHref(page + 1)} className="rounded-lg border border-border px-3 py-1.5 hover:bg-muted">Older →</Link>}
          </div>
        </div>
      )}
    </div>
  );
}
