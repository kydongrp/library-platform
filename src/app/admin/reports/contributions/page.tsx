import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { Card, EmptyState } from "@/components/ui";
import { getContributionData, type StaffTotals } from "@/lib/contributions";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

// Categorical palette, fixed series order — validated (six checks, light surface).
const SERIES = [
  { key: "epPicks", label: "Editor's Picks curated", color: "#0d9488" },
  { key: "decisions", label: "Nominations decided", color: "#b45309" },
  { key: "reviews", label: "Reviews (staff members)", color: "#4f46e5" },
] as const;

const BAR_H = 10; // thin marks
const BAR_GAP = 2; // surface gap between adjacent bars
const ROW_PAD = 12;
const ROW_H = SERIES.length * BAR_H + (SERIES.length - 1) * BAR_GAP + ROW_PAD * 2;
const LABEL_W = 150;
const VALUE_W = 34;
const CHART_W = 640;

/** Grouped horizontal bars: one row per staff, one bar per metric. */
function ContributionChart({ rows, chartId }: { rows: StaffTotals[]; chartId: string }) {
  const max = Math.max(1, ...rows.flatMap((r) => SERIES.map((s) => r[s.key])));
  const plotW = CHART_W - LABEL_W - VALUE_W;
  const h = rows.length * ROW_H;
  const x = (v: number) => (v / max) * plotW;

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${h}`}
      role="img"
      aria-label="Contributions per staff member"
      className="w-full"
      style={{ maxWidth: CHART_W }}
    >
      <defs>
        {/* Round only the data end: bars start 4px left of the plot edge and
            the clip squares off the baseline side. */}
        <clipPath id={`plot-${chartId}`}>
          <rect x={LABEL_W} y={0} width={plotW + VALUE_W} height={h} />
        </clipPath>
      </defs>
      {/* Recessive gridlines at 25/50/75/100% */}
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line
          key={f}
          x1={LABEL_W + f * plotW}
          x2={LABEL_W + f * plotW}
          y1={0}
          y2={h}
          stroke="#e7e5e4"
          strokeWidth="1"
        />
      ))}
      {rows.map((r, ri) => {
        const top = ri * ROW_H + ROW_PAD;
        return (
          <g key={r.name}>
            <text
              x={LABEL_W - 10}
              y={ri * ROW_H + ROW_H / 2}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize="12.5"
              fontWeight="600"
              fill="#44403c"
            >
              {r.name}
            </text>
            {SERIES.map((s, si) => {
              const v = r[s.key];
              const y = top + si * (BAR_H + BAR_GAP);
              const w = x(v);
              return (
                <g key={s.key} clipPath={`url(#plot-${chartId})`}>
                  <title>{`${r.name} — ${s.label}: ${v}`}</title>
                  {v > 0 && (
                    <rect
                      x={LABEL_W - 4}
                      y={y}
                      width={w + 4}
                      height={BAR_H}
                      rx="4"
                      fill={s.color}
                    />
                  )}
                  {v === 0 && (
                    <rect x={LABEL_W} y={y} width={2} height={BAR_H} fill="#e7e5e4" />
                  )}
                  <text
                    x={LABEL_W + w + 6}
                    y={y + BAR_H / 2 + 0.5}
                    dominantBaseline="middle"
                    fontSize="11"
                    fill="#78716c"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {v}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

function Legend() {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5">
      {SERIES.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

export default async function ContributionsPage() {
  await requireAdminView("REPORTS");
  const data = await getContributionData();

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/admin/reports" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back to reports
      </Link>
      <div className="mb-6 mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Staff Contributions</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Who curates Editor's Picks, decides learner nominations, and writes
            reviews — all-time and for the trailing three calendar months.
            Follower counts live in the Learner Portal and will appear here once
            the portal integration lands.
          </p>
        </div>
        <a
          href="/admin/reports/contributions/export"
          className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          ⇩ Export CSV
        </a>
      </div>

      <Legend />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-1 font-display text-lg font-semibold">All time</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Every attributed contribution on record.
          </p>
          {data.allTime.length === 0 ? (
            <EmptyState title="No contributions yet" description="Curate a pick or decide a nomination to start the tally." />
          ) : (
            <ContributionChart rows={data.allTime} chartId="all" />
          )}
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 font-display text-lg font-semibold">Past 3 months</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Since {formatDate(data.from3)} (current month plus the two before it).
          </p>
          {data.last3Months.length === 0 ? (
            <EmptyState title="Quiet quarter" description="No attributed contributions in the window." />
          ) : (
            <ContributionChart rows={data.last3Months} chartId="q" />
          )}
        </Card>
      </div>

      {/* Monthly breakdown */}
      <Card className="mt-6 overflow-hidden p-0">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-display text-lg font-semibold">Monthly breakdown</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Totals across all staff for the last {data.monthly.length} calendar months.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-2.5 font-medium">Month</th>
                {SERIES.map((s) => (
                  <th key={s.key} className="px-5 py-2.5 text-right font-medium">
                    <span className="mr-1.5 inline-block h-2 w-2 rounded-sm align-baseline" style={{ background: s.color }} />
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody style={{ fontVariantNumeric: "tabular-nums" }}>
              {data.monthly.map((m) => (
                <tr key={m.key} className="border-b border-border last:border-0">
                  <td className="px-5 py-2.5 font-medium">{m.label}</td>
                  <td className="px-5 py-2.5 text-right">{m.epPicks}</td>
                  <td className="px-5 py-2.5 text-right">{m.decisions}</td>
                  <td className="px-5 py-2.5 text-right">{m.reviews}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
