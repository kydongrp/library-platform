import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { Card, EmptyState } from "@/components/ui";
import { REPORTS, runReport } from "@/lib/reports";
import { MODULE_REPORTS, DATE_RANGED_MODULE_REPORTS } from "@/lib/reports-modules";
import { MEMBER_TYPES, MEMBER_TYPE_LABELS } from "@/lib/constants";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  report?: string;
  from?: string;
  to?: string;
  memberType?: string;
}>;

const inputCls =
  "rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

export default async function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminView("REPORTS");
  const { report = "", from = "", to = "", memberType = "" } = await searchParams;

  // The five original standard reports plus the per-module reports, presented
  // as one list grouped by the module each report belongs to.
  const ALL_REPORTS = [...REPORTS, ...MODULE_REPORTS];
  const GROUPS = ["Loans", "Members", "Catalogue", "Items", "Acquisitions", "Serials"];

  const active = ALL_REPORTS.find((r) => r.key === report);
  const result = active ? await runReport(active.key, { from, to, memberType }) : null;
  const showsDates =
    !!active &&
    (["loans", "overdue"].includes(active.key) || DATE_RANGED_MODULE_REPORTS.includes(active.key));
  // Member type only narrows the reports that are actually keyed to a member.
  const showsMemberType = !!active && ["loans", "overdue", "member-activity"].includes(active.key);
  const exportQs = new URLSearchParams({ report, from, to, memberType }).toString();

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Standard Reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Operational reports with export to Excel-compatible CSV.
        </p>
      </div>

      {/* Report picker, grouped by module */}
      {GROUPS.map((group) => {
        const inGroup = ALL_REPORTS.filter((r) => r.group === group);
        if (inGroup.length === 0) return null;
        return (
          <div key={group} className="mb-5">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {inGroup.map((r) => (
                <Link
                  key={r.key}
                  href={`/admin/reports?report=${r.key}`}
                  className={`rounded-xl border p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md ${
                    report === r.key ? "border-primary bg-primary/5" : "border-border bg-card"
                  }`}
                >
                  <p className="text-sm font-semibold">{r.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{r.description}</p>
                </Link>
              ))}
            </div>
          </div>
        );
      })}

      <div className="mb-6">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Charted
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Link
            href="/admin/reports/contributions"
            className="rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
          >
            <p className="text-sm font-semibold">Staff Contributions</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Editor&rsquo;s Picks, nomination decisions, and reviews per staff, charted for all time and
              the past 3 months.
            </p>
          </Link>
          <Link
            href="/admin/reports/flexi"
            className="rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
          >
            <p className="text-sm font-semibold">FlexiReports</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Build your own tabular report: pick a cube, choose rows, columns and a measure, view
              as a graph or export to Excel.
            </p>
          </Link>
          <Link
            href="/admin/dashboards/catalogue"
            className="rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
          >
            <p className="text-sm font-semibold">Module Dashboards</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The same figures as trend charts, one dashboard per module.
            </p>
          </Link>
        </div>
      </div>

      {!active ? (
        <EmptyState title="Pick a report" description="Choose a report above to run it." />
      ) : (
        <Card className="p-5">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-display text-xl font-semibold">{active.name}</h2>
              <p className="text-sm text-muted-foreground">
                {result!.rows.length} row{result!.rows.length === 1 ? "" : "s"}
              </p>
              {result!.note && (
                <p className="mt-1 text-xs text-accent">{result!.note}</p>
              )}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              {(showsDates || showsMemberType) && (
                <form className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="report" value={active.key} />
                  {showsDates && (
                    <>
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground" htmlFor="rpt-from">From</label>
                        <input id="rpt-from" type="date" name="from" defaultValue={from} className={inputCls} />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground" htmlFor="rpt-to">To</label>
                        <input id="rpt-to" type="date" name="to" defaultValue={to} className={inputCls} />
                      </div>
                    </>
                  )}
                  {showsMemberType && (
                    <div>
                      <label className="mb-1 block text-xs text-muted-foreground" htmlFor="rpt-mt">Member type</label>
                      <select id="rpt-mt" name="memberType" defaultValue={memberType} className={inputCls}>
                        <option value="">All</option>
                        {MEMBER_TYPES.map((t) => (
                          <option key={t} value={t}>{MEMBER_TYPE_LABELS[t]}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
                    Apply
                  </button>
                </form>
              )}
              <a
                href={`/admin/reports/export?${exportQs}`}
                className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                ⬇ Export CSV
              </a>
            </div>
          </div>

          {result!.rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No rows match the criteria.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    {result!.columns.map((c) => (
                      <th key={c} className="py-2 pr-4 font-medium">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {result!.rows.map((row, i) => (
                    <tr key={i} className="hover:bg-muted/40">
                      {row.map((cell, j) => (
                        <td key={j} className="max-w-64 truncate py-2 pr-4">{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
