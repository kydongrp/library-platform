import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { Card, EmptyState } from "@/components/ui";
import { BarChart, ColumnChart, StackedBars, CHART_SERIES } from "@/components/charts";
import { CUBES, FLEXI_ROW_CAP, getCube, parseRange } from "@/lib/flexi";
import { pivot, type DimensionDef, type Pivot } from "@/lib/flexi-core";
import { formatFine } from "@/lib/fines";
import { FlexiForm } from "./flexi-form";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  cube?: string;
  rows?: string;
  cols?: string;
  measure?: string;
  view?: string;
  from?: string;
  to?: string;
}>;

const VIEWS = [
  { key: "table", label: "Table only" },
  { key: "bar", label: "Bar chart" },
  { key: "columns", label: "Column chart" },
  { key: "stacked", label: "Stacked bars" },
] as const;

const inputCls =
  "rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

/** Chart series budget: the validated palette has exactly five slots. */
const CHART_SERIES_MAX = CHART_SERIES.length;
const CHART_BARS_MAX = 12;

export default async function FlexiReportsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminView("REPORTS");
  const sp = await searchParams;

  const cube = getCube(sp.cube);
  let result: Pivot | null = null;
  let chart: Pivot | null = null;
  let rowDim = cube?.dimensions[0];
  let colDim: DimensionDef | null = null;
  let measure = cube?.measures[0];
  let view = VIEWS.some((v) => v.key === sp.view) ? sp.view! : "table";
  let rowCount = 0;

  if (cube) {
    // Unknown params fall back to the cube's defaults rather than erroring.
    rowDim =
      cube.dimensions.find((d) => d.key === sp.rows) ??
      cube.dimensions.find((d) => d.key === cube.defaults.row) ??
      cube.dimensions[0];
    colDim =
      sp.cols === "none"
        ? null
        : (cube.dimensions.find((d) => d.key === (sp.cols ?? cube.defaults.col)) ?? null);
    if (colDim && colDim.key === rowDim.key) colDim = null;
    measure =
      cube.measures.find((m) => m.key === sp.measure) ??
      cube.measures.find((m) => m.key === cube.defaults.measure) ??
      cube.measures[0];
    // Chart modes that cross two dimensions need a column dimension.
    if (!colDim && (view === "columns" || view === "stacked")) view = "bar";

    const data = await cube.fetch(parseRange(sp.from, sp.to));
    rowCount = data.length;
    result = pivot(data, rowDim, colDim, measure, { maxRows: 200, maxCols: 30 });
    if (view === "bar") {
      chart = pivot(data, rowDim, null, measure, { maxRows: CHART_BARS_MAX });
    } else if (view === "columns" || view === "stacked") {
      // Palette budget: fold the smaller side of the cross to five series.
      chart =
        view === "columns"
          ? // 18 x-labels keeps the axis legible after tick thinning.
            pivot(data, colDim!, rowDim, measure, { maxRows: 18, maxCols: CHART_SERIES_MAX })
          : pivot(data, rowDim, colDim, measure, { maxRows: CHART_BARS_MAX, maxCols: CHART_SERIES_MAX });
    }
  }

  const money = measure?.format === "money";
  const fmt = (v: number) => (money ? formatFine(v) : v.toLocaleString("en-SG"));
  // Charts carry plain numbers; money charts show dollars, stated in the subtitle.
  const chartValue = (v: number) => (money ? Math.round(v) / 100 : v);
  const chartSubtitle = (base: string) => (money ? `${base} · in S$` : base);

  const qs = (over: Record<string, string>) =>
    "/admin/reports/flexi?" +
    new URLSearchParams({
      cube: cube?.key ?? "",
      rows: rowDim?.key ?? "",
      cols: colDim?.key ?? "none",
      measure: measure?.key ?? "",
      view,
      from: sp.from ?? "",
      to: sp.to ?? "",
      ...over,
    }).toString();

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">FlexiReports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Statistical reports across modules: pick a cube, choose your own rows and columns, view
          as a graph, export to Excel-compatible CSV.
        </p>
      </div>

      {/* Cube selectors: the five preset starting points. */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CUBES.map((c) => (
          <Link
            key={c.key}
            href={`/admin/reports/flexi?cube=${c.key}`}
            className={`rounded-xl border p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md ${
              cube?.key === c.key ? "border-primary bg-primary/5" : "border-border bg-card"
            }`}
          >
            <p className="text-sm font-semibold">{c.name}</p>
            <p className="mt-1 text-xs text-muted-foreground">{c.description}</p>
          </Link>
        ))}
      </div>

      {!cube || !result || !rowDim || !measure ? (
        <EmptyState
          title="Pick a cube"
          description="Choose one of the five analysis cubes above as the starting point for a tabular report."
        />
      ) : (
        <Card className="p-5">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-display text-xl font-semibold">{cube.name}</h2>
              <p className="text-sm text-muted-foreground">
                {measure.label} by {rowDim.label.toLowerCase()}
                {colDim ? ` × ${colDim.label.toLowerCase()}` : ""} · grand total {fmt(result.grandTotal)}
              </p>
              {rowCount >= FLEXI_ROW_CAP && (
                <p className="mt-1 text-xs text-accent">
                  Computed over the most recent {FLEXI_ROW_CAP.toLocaleString()} {cube.unit}, and
                  the export is capped to the same window. Narrow the date range for exact totals.
                </p>
              )}
            </div>
            <a
              href={`/admin/reports/flexi/export?${new URLSearchParams({
                cube: cube.key,
                rows: rowDim.key,
                cols: colDim?.key ?? "none",
                measure: measure.key,
                from: sp.from ?? "",
                to: sp.to ?? "",
              }).toString()}`}
              className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              ⬇ Export CSV
            </a>
          </div>

          {/* The pivot controls. Keyed by the full criteria state so the
              uncontrolled selects remount (and re-sync) on soft navigations. */}
          <FlexiForm
            key={[cube.key, rowDim.key, colDim?.key ?? "none", measure.key, view, sp.from, sp.to].join("|")}
            className="mb-5 flex flex-wrap items-end gap-2 rounded-lg border border-border bg-muted/30 p-3"
          >
            <input type="hidden" name="cube" value={cube.key} />
            <div>
              <label className="mb-1 block text-xs text-muted-foreground" htmlFor="fx-rows">
                Rows
              </label>
              <select id="fx-rows" name="rows" defaultValue={rowDim.key} className={inputCls}>
                {cube.dimensions.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground" htmlFor="fx-cols">
                Columns
              </label>
              <select id="fx-cols" name="cols" defaultValue={colDim?.key ?? "none"} className={inputCls}>
                <option value="none">None</option>
                {cube.dimensions.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground" htmlFor="fx-measure">
                Measure
              </label>
              <select id="fx-measure" name="measure" defaultValue={measure.key} className={inputCls}>
                {cube.measures.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground" htmlFor="fx-view">
                Display
              </label>
              <select id="fx-view" name="view" defaultValue={view} className={inputCls}>
                {VIEWS.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground" htmlFor="fx-from">
                From ({cube.dateLabel})
              </label>
              <input id="fx-from" type="date" name="from" defaultValue={sp.from} className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground" htmlFor="fx-to">
                To
              </label>
              <input id="fx-to" type="date" name="to" defaultValue={sp.to} className={inputCls} />
            </div>
          </FlexiForm>

          {/* Graph view, when one is selected. The table below stays regardless. */}
          {chart && view === "bar" && (
            <div className="mb-6">
              <BarChart
                title={`${measure.label} by ${rowDim.label.toLowerCase()}`}
                subtitle={chartSubtitle(
                  chart.foldedRows > 0 ? `top ${CHART_BARS_MAX - 1} shown, rest folded` : "all values",
                )}
                data={chart.rowLabels.map((label, i) => ({
                  label,
                  value: chartValue(chart!.rowTotals[i]),
                  // One measure, one hue: bar identity is the label, not a colour.
                  color: CHART_SERIES[0],
                }))}
                valueLabel={money ? `${measure.label} (S$)` : measure.label}
                emptyLabel="Nothing matches the criteria."
              />
            </div>
          )}
          {chart && view === "columns" && colDim && (
            <div className="mb-6">
              <ColumnChart
                title={`${measure.label} by ${colDim.label.toLowerCase()}`}
                subtitle={chartSubtitle(`series: ${rowDim.label.toLowerCase()}`)}
                labels={chart.rowLabels}
                series={chart.colLabels.map((name, ci) => ({
                  name,
                  values: chart!.cells.map((row) => chartValue(row[ci])),
                }))}
              />
            </div>
          )}
          {chart && view === "stacked" && colDim && (
            <div className="mb-6">
              <StackedBars
                title={`${measure.label} by ${rowDim.label.toLowerCase()}, split by ${colDim.label.toLowerCase()}`}
                subtitle={chartSubtitle("segment share within each bar")}
                format={(n) => (money ? formatFine(Math.round(n * 100)) : n.toLocaleString("en-SG"))}
                rows={chart.rowLabels.map((label, ri) => ({
                  label,
                  segments: chart!.colLabels.map((name, ci) => ({
                    name,
                    value: chartValue(chart!.cells[ri][ci]),
                    color: CHART_SERIES[ci % CHART_SERIES.length],
                  })),
                }))}
              />
            </div>
          )}

          {/* The tabular report itself. */}
          {result.rowLabels.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No rows match the criteria.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">{rowDim.label}</th>
                    {result.colLabels.map((c) => (
                      <th key={c} className="py-2 pr-4 text-right font-medium">
                        {c}
                      </th>
                    ))}
                    {colDim && <th className="py-2 pr-4 text-right font-medium">Total</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {result.rowLabels.map((label, ri) => (
                    <tr key={label} className="hover:bg-muted/40">
                      <td className="max-w-64 truncate py-2 pr-4 font-medium" title={label}>
                        {label}
                      </td>
                      {result!.cells[ri].map((v, ci) => (
                        <td
                          key={ci}
                          className="py-2 pr-4 text-right"
                          style={{ fontVariantNumeric: "tabular-nums" }}
                        >
                          {/* count/distinct zero means "no rows here"; a sum's
                              zero is real data (rows that add to nothing). */}
                          {v === 0 && measure.kind !== "sum" ? (
                            <span className="text-muted-foreground/50">·</span>
                          ) : (
                            fmt(v)
                          )}
                        </td>
                      ))}
                      {colDim && (
                        <td
                          className="py-2 pr-4 text-right font-medium"
                          style={{ fontVariantNumeric: "tabular-nums" }}
                        >
                          {fmt(result!.rowTotals[ri])}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border font-medium">
                    <td className="py-2 pr-4">Total</td>
                    {result.colTotals.map((v, ci) => (
                      <td
                        key={ci}
                        className="py-2 pr-4 text-right"
                        style={{ fontVariantNumeric: "tabular-nums" }}
                      >
                        {fmt(v)}
                      </td>
                    ))}
                    {colDim && (
                      <td
                        className="py-2 pr-4 text-right"
                        style={{ fontVariantNumeric: "tabular-nums" }}
                      >
                        {fmt(result.grandTotal)}
                      </td>
                    )}
                  </tr>
                </tfoot>
              </table>
              {(result.foldedRows > 0 || result.foldedCols > 0) && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {result.foldedRows > 0 &&
                    `${result.foldedRows} smaller row values are folded into one bucket. `}
                  {result.foldedCols > 0 &&
                    `${result.foldedCols} column values are folded into one bucket. `}
                  Distinct counts stay exact through the fold.
                </p>
              )}
            </div>
          )}

          <p className="mt-4 text-xs text-muted-foreground">
            <Link href={qs({ view: "table" })} className="hover:underline">
              Reset to table
            </Link>
            {" · "}
            <Link href="/admin/reports" className="hover:underline">
              Back to standard reports
            </Link>
          </p>
        </Card>
      )}
    </div>
  );
}
