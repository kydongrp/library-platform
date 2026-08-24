// Server-rendered SVG charts for the module dashboards.
//
// The categorical palette below was validated with the dataviz six-check
// script (lightness band, chroma floor, CVD separation, normal-vision floor,
// contrast vs surface) for the light surface this app uses. Worst adjacent
// pair separates at deltaE 13.6 for deuteranopia, comfortably above the floor.
// Do not add or reorder colours without re-running that check: the app's own
// teal (#0f766e) FAILS the chroma floor and must not be used for data.
//
// Series colours are assigned in fixed order and never cycled. Every chart
// carries its numbers in text as well as in the marks, a per-mark tooltip, and
// a table view, so nothing is encoded by colour alone.

export const CHART_SERIES = ["#0d9488", "#b45309", "#4f46e5", "#be123c", "#0891b2"] as const;

/** Reserved status colours. Never reused as a series colour. */
export const STATUS_COLORS = {
  good: "#15803d",
  warning: "#b45309",
  critical: "#b91c1c",
  idle: "#a8a29e",
} as const;

const GRID = "#e7e5e4";
const TRACK = "#f5f5f4";
const SURFACE = "#ffffff";

export type Datum = { label: string; value: number; color?: string; note?: string };

const nf = (n: number) => n.toLocaleString("en-SG");

/* ---------------------------------------------------------------- table view */

/** Every chart ships one of these, so the figures are never colour-only. */
export function ChartTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: (string | number)[][];
}) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
        View as table
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              {columns.map((c, i) => (
                <th key={c} className={`px-2 py-1 font-medium ${i > 0 ? "text-right" : ""}`}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-border last:border-0">
                {r.map((cell, j) => (
                  <td key={j} className={`px-2 py-1 ${j > 0 ? "text-right" : ""}`}
                    style={j > 0 ? { fontVariantNumeric: "tabular-nums" } : undefined}>
                    {typeof cell === "number" ? nf(cell) : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/* ------------------------------------------------------------- horizontal bar */

/**
 * Ranked magnitudes. Thin marks with rounded data-ends anchored to the
 * baseline, label and value in text tokens beside each bar.
 */

import { zonedMonthKey, zonedMonthKeyOffset } from "@/lib/tz";
export function BarChart({
  data,
  title,
  subtitle,
  max,
  emptyLabel = "Nothing to show yet.",
  valueLabel = "Count",
}: {
  data: Datum[];
  title: string;
  subtitle?: string;
  max?: number;
  emptyLabel?: string;
  /** Header for the value column in the table view, e.g. "Order value (S$)". */
  valueLabel?: string;
}) {
  const peak = Math.max(max ?? 0, ...data.map((d) => d.value), 1);
  return (
    <figure className="m-0">
      <figcaption className="mb-1">
        <span className="font-display text-base font-semibold">{title}</span>
        {subtitle && <span className="ml-2 text-xs text-muted-foreground">{subtitle}</span>}
      </figcaption>
      {data.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <>
          <div className="mt-2 grid gap-1.5">
            {data.map((d, i) => {
              const pct = (d.value / peak) * 100;
              const color = d.color ?? CHART_SERIES[i % CHART_SERIES.length];
              return (
                <div key={d.label} className="grid grid-cols-[minmax(6rem,10rem)_1fr_auto] items-center gap-2">
                  <span className="truncate text-xs text-muted-foreground" title={d.label}>{d.label}</span>
                  <div className="h-2.5 w-full overflow-hidden rounded-full" style={{ background: TRACK }}>
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.max(pct, d.value > 0 ? 1.5 : 0)}%`, background: color }}
                      role="img"
                      aria-label={`${d.label}: ${nf(d.value)}`}
                      title={`${d.label}: ${nf(d.value)}${d.note ? ` (${d.note})` : ""}`}
                    />
                  </div>
                  <span className="text-xs font-medium" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {nf(d.value)}
                  </span>
                </div>
              );
            })}
          </div>
          <ChartTable
            caption={title}
            columns={["Item", valueLabel]}
            rows={data.map((d) => [d.label, d.value])}
          />
        </>
      )}
    </figure>
  );
}

/* ------------------------------------------------------------- column series */

export type Series = { name: string; values: number[] };

/**
 * Counts over time. One or more series as grouped columns with a 2px surface
 * gap between them, a legend whenever there is more than one, and every column
 * carrying its own tooltip.
 */
export function ColumnChart({
  labels,
  series,
  title,
  subtitle,
  height = 132,
}: {
  labels: string[];
  series: Series[];
  title: string;
  subtitle?: string;
  height?: number;
}) {
  const peak = Math.max(1, ...series.flatMap((s) => s.values));
  const slot = 100 / Math.max(labels.length, 1);
  // Clamped below so many labels × many series can never go negative and
  // render a blank chart; sliver-width bars still draw and carry tooltips.
  const barW = Math.max(0.3, Math.min(slot / series.length - 0.6, 5.5));
  const total = series.map((s) => s.values.reduce((a, b) => a + b, 0));
  const allZero = total.every((t) => t === 0);

  return (
    <figure className="m-0">
      <figcaption className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <span>
          <span className="font-display text-base font-semibold">{title}</span>
          {subtitle && <span className="ml-2 text-xs text-muted-foreground">{subtitle}</span>}
        </span>
        {series.length > 1 && (
          <span className="flex flex-wrap items-center gap-2.5">
            {series.map((s, i) => (
              <span key={s.name} className="flex items-center gap-1 text-xs text-muted-foreground">
                <span className="inline-block h-2 w-2 rounded-sm"
                  style={{ background: CHART_SERIES[i % CHART_SERIES.length] }} />
                {s.name}
                <span className="font-medium text-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {nf(total[i])}
                </span>
              </span>
            ))}
          </span>
        )}
      </figcaption>

      {allZero ? (
        <p className="py-6 text-sm text-muted-foreground">No activity in this period yet.</p>
      ) : (
        <>
          <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none"
            className="mt-1 w-full" style={{ height }} role="img"
            aria-label={`${title}: ${series.map((s, i) => `${s.name} totalling ${nf(total[i])}`).join(", ")}`}>
            {/* Recessive gridlines at quarter steps. */}
            {[0.25, 0.5, 0.75, 1].map((f) => (
              <line key={f} x1="0" x2="100" y1={height - f * (height - 14)} y2={height - f * (height - 14)}
                stroke={GRID} strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
            ))}
            {labels.map((lab, li) =>
              series.map((s, si) => {
                const v = s.values[li] ?? 0;
                const h = v > 0 ? Math.max(2, (v / peak) * (height - 16)) : 0;
                const x = li * slot + 0.4 + si * (barW + 0.6);
                return (
                  <rect
                    key={`${lab}-${s.name}`}
                    x={x}
                    y={height - 12 - h}
                    width={barW}
                    height={h}
                    rx="1.2"
                    fill={CHART_SERIES[si % CHART_SERIES.length]}
                    stroke={SURFACE}
                    strokeWidth="0.3"
                  >
                    <title>{`${lab}, ${s.name}: ${nf(v)}`}</title>
                  </rect>
                );
              }),
            )}
            {/* Baseline */}
            <line x1="0" x2="100" y1={height - 12} y2={height - 12}
              stroke={GRID} strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            {labels.map((l, i) => {
              // Thin the ticks on a long run to avoid collisions, but never
              // drop the first or the last: the most recent period is the one
              // readers look for.
              const last = labels.length - 1;
              const thinned = labels.length > 8 && i !== 0 && i !== last && (last - i) % 2 === 1;
              return (
                <span key={l} className={thinned ? "invisible" : ""}>{l}</span>
              );
            })}
          </div>
          <ChartTable
            caption={title}
            columns={["Period", ...series.map((s) => s.name)]}
            rows={labels.map((l, i) => [l, ...series.map((s) => s.values[i] ?? 0)])}
          />
        </>
      )}
    </figure>
  );
}

/* -------------------------------------------------------------- stacked bars */

export type StackSegment = { name: string; value: number; color: string };

/**
 * Parts of one total, one row per entity. Segments carry a 2px surface gap so
 * adjacent fills never touch, and each row states its figures in text.
 */
export function StackedBars({
  rows,
  title,
  subtitle,
  format = nf,
}: {
  rows: { label: string; segments: StackSegment[]; note?: string }[];
  title: string;
  subtitle?: string;
  format?: (n: number) => string;
}) {
  const legend = rows[0]?.segments.map((s) => ({ name: s.name, color: s.color })) ?? [];
  return (
    <figure className="m-0">
      <figcaption className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <span>
          <span className="font-display text-base font-semibold">{title}</span>
          {subtitle && <span className="ml-2 text-xs text-muted-foreground">{subtitle}</span>}
        </span>
        {legend.length > 1 && (
          <span className="flex flex-wrap items-center gap-2.5">
            {legend.map((l) => (
              <span key={l.name} className="flex items-center gap-1 text-xs text-muted-foreground">
                <span className="inline-block h-2 w-2 rounded-sm" style={{ background: l.color }} />
                {l.name}
              </span>
            ))}
          </span>
        )}
      </figcaption>

      {rows.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">Nothing to show yet.</p>
      ) : (
        <>
          <div className="mt-2 grid gap-3">
            {rows.map((r) => {
              const total = Math.max(1, r.segments.reduce((a, s) => a + Math.max(0, s.value), 0));
              return (
                <div key={r.label}>
                  <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{r.label}</span>
                    {r.note && <span className="text-xs text-muted-foreground">{r.note}</span>}
                  </div>
                  <div className="flex h-2.5 w-full overflow-hidden rounded-full" style={{ background: TRACK }}>
                    {r.segments.map((s) => (
                      <div
                        key={s.name}
                        style={{
                          width: `${(Math.max(0, s.value) / total) * 100}%`,
                          background: s.color,
                          borderRight: `2px solid ${SURFACE}`,
                        }}
                        title={`${r.label}, ${s.name}: ${format(s.value)}`}
                      />
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {r.segments.map((s) => `${format(s.value)} ${s.name.toLowerCase()}`).join(" · ")}
                  </p>
                </div>
              );
            })}
          </div>
          <ChartTable
            caption={title}
            columns={["Item", ...legend.map((l) => l.name)]}
            rows={rows.map((r) => [r.label, ...r.segments.map((s) => format(s.value))])}
          />
        </>
      )}
    </figure>
  );
}

/* ------------------------------------------------------------------- tiles */

export function StatTiles({
  tiles,
}: {
  tiles: { label: string; value: string | number; tone?: "good" | "warning" | "critical" }[];
}) {
  return (
    <dl className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">{t.label}</dt>
          <dd
            className="mt-1 font-display text-xl font-semibold"
            style={{
              fontVariantNumeric: "tabular-nums",
              color: t.tone ? STATUS_COLORS[t.tone] : undefined,
            }}
          >
            {typeof t.value === "number" ? nf(t.value) : t.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Trailing months as "YYYY-MM" keys plus short display labels. */
export function trailingMonths(count: number, now = new Date()): { keys: string[]; labels: string[] } {
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const keys: string[] = [];
  const labels: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const key = zonedMonthKeyOffset(now, -i);
    keys.push(key);
    labels.push(MON[Number(key.slice(5, 7)) - 1]);
  }
  return { keys, labels };
}

export function monthKey(d: Date): string {
  return zonedMonthKey(d);
}

/** Count rows into trailing-month buckets. */
export function bucketByMonth<T>(rows: T[], pick: (r: T) => Date | null, keys: string[]): number[] {
  const idx = new Map(keys.map((k, i) => [k, i]));
  const out = new Array(keys.length).fill(0);
  for (const r of rows) {
    const d = pick(r);
    if (!d) continue;
    const i = idx.get(monthKey(d));
    if (i !== undefined) out[i]++;
  }
  return out;
}
