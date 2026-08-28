/**
 * FlexiReports pivot core (SDD "FlexiReports": statistical reports with
 * selected fields across modules; comparison rows 79-80).
 *
 * Pure logic, safe to import from anywhere: the cube definitions that feed it
 * live in src/lib/flexi.ts (server-only, prisma-backed). Keep it that way:
 * importing prisma here would poison any client bundle that touches this file.
 *
 * The pivot is computed over flat in-memory rows rather than dynamic SQL:
 * cube fetches are capped (FLEXI_ROW_CAP in flexi.ts), grouping two arbitrary
 * dimensions across relations is outside prisma groupBy anyway, and composing
 * SQL from user-picked field names is an injection hazard this avoids
 * entirely.
 */

import { zonedMonthKey, zonedYearKey } from "@/lib/tz";

/**
 * Placeholder bucket for rows where the dimension has no value. A word, not a
 * dash: free-text data (titles, locations) can legitimately contain a dash,
 * which would silently pool real values into the missing bucket.
 */
export const MISSING = "(none)";

/**
 * How a pivot can be presented. Lives here rather than in the page so the
 * natural-language layer (src/lib/flexi-nl.ts) validates against the same list
 * the page renders, instead of a second copy that can drift out of step.
 *
 * "columns" and "stacked" need a column dimension to stack or group by; the
 * page downgrades them to "bar" when none was chosen.
 */
export const VIEWS = [
  { key: "table", label: "Table only" },
  { key: "bar", label: "Bar chart" },
  { key: "columns", label: "Column chart" },
  { key: "stacked", label: "Stacked bars" },
] as const;

export type ViewKey = (typeof VIEWS)[number]["key"];

/** Views that are meaningless without a column dimension. */
export const VIEWS_NEEDING_COLUMNS: readonly string[] = ["columns", "stacked"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DimensionDef<R = any> = {
  key: string;
  label: string;
  /** Extract the display value for a row. null/undefined/"" fold into MISSING. */
  get: (row: R) => string | null | undefined;
  /**
   * Temporal dimensions ("2026-08", "2026", "FY2026") sort ascending by value;
   * everything else sorts descending by measure total. Folding also differs:
   * temporal folds the OLDEST values into "Earlier", others fold the SMALLEST
   * into "Other".
   */
  temporal?: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MeasureDef<R = any> = {
  key: string;
  label: string;
  /** count = rows; sum = of(row) as number; distinct = unique of(row) values. */
  kind: "count" | "sum" | "distinct";
  of?: (row: R) => unknown;
  /** money is integer cents, formatted at display/export time. */
  format: "int" | "money";
};

export type Pivot = {
  rowLabels: string[];
  /** Single element (the measure label) when no column dimension was chosen. */
  colLabels: string[];
  /** cells[r][c], same order as rowLabels × colLabels. */
  cells: number[][];
  rowTotals: number[];
  colTotals: number[];
  grandTotal: number;
  /** How many distinct values were folded into the Other/Earlier bucket. */
  foldedRows: number;
  foldedCols: number;
};

type Acc = { n: number; set: Set<unknown> };

const newAcc = (): Acc => ({ n: 0, set: new Set() });

function bump<R>(acc: Acc, row: R, m: MeasureDef<R>): void {
  if (m.kind === "count") acc.n += 1;
  else if (m.kind === "sum") acc.n += Number(m.of!(row)) || 0;
  else acc.set.add(m.of!(row));
}

function mergeAcc(into: Acc, from: Acc): void {
  into.n += from.n;
  for (const v of from.set) into.set.add(v);
}

const valueOf = (acc: Acc, m: MeasureDef) => (m.kind === "distinct" ? acc.set.size : acc.n);

/** Bucket label for folded values. */
export function foldLabel(temporal: boolean, folded: number): string {
  return temporal ? `Earlier (${folded})` : `Other (${folded})`;
}

/**
 * Order the dimension's values and fold the overflow into one bucket.
 * Returns the kept values in display order plus the set of folded values.
 */
function orderAndFold(
  values: string[],
  totals: Map<string, Acc>,
  m: MeasureDef,
  temporal: boolean,
  max: number,
): { kept: string[]; folded: string[] } {
  const real = values.filter((v) => v !== MISSING);
  if (temporal) {
    real.sort(); // ISO-shaped strings sort chronologically
  } else {
    real.sort((a, b) => valueOf(totals.get(b)!, m) - valueOf(totals.get(a)!, m) || a.localeCompare(b));
  }
  // MISSING always trails the list and is never the fold survivor of choice.
  const ordered = values.includes(MISSING) ? [...real, MISSING] : real;
  if (ordered.length <= max) return { kept: ordered, folded: [] };
  // Temporal keeps the newest, folds the oldest; others keep the largest.
  const folded = temporal ? ordered.slice(0, ordered.length - (max - 1)) : ordered.slice(max - 1);
  const kept = temporal ? ordered.slice(ordered.length - (max - 1)) : ordered.slice(0, max - 1);
  return { kept, folded };
}

/**
 * Cross-tabulate `rows` by rowDim × colDim (colDim optional) for one measure.
 *
 * Distinct measures stay as Sets until the very end, so row totals, column
 * totals and the grand total are true unions, never sums of subtotals, which
 * would double-count an entity that appears in several cells.
 */
export function pivot<R>(
  rows: R[],
  rowDim: DimensionDef<R>,
  colDim: DimensionDef<R> | null,
  measure: MeasureDef<R>,
  opts: { maxRows?: number; maxCols?: number } = {},
): Pivot {
  const maxRows = opts.maxRows ?? 200;
  const maxCols = opts.maxCols ?? 30;

  const cellAcc = new Map<string, Map<string, Acc>>();
  const rowAcc = new Map<string, Acc>();
  const colAcc = new Map<string, Acc>();
  const grand = newAcc();

  for (const row of rows) {
    const rv = rowDim.get(row) || MISSING;
    const cv = colDim ? colDim.get(row) || MISSING : "";
    let byCol = cellAcc.get(rv);
    if (!byCol) cellAcc.set(rv, (byCol = new Map()));
    let cell = byCol.get(cv);
    if (!cell) byCol.set(cv, (cell = newAcc()));
    bump(cell, row, measure);
    let ra = rowAcc.get(rv);
    if (!ra) rowAcc.set(rv, (ra = newAcc()));
    bump(ra, row, measure);
    let ca = colAcc.get(cv);
    if (!ca) colAcc.set(cv, (ca = newAcc()));
    bump(ca, row, measure);
    bump(grand, row, measure);
  }

  const rowFold = orderAndFold([...rowAcc.keys()], rowAcc, measure, !!rowDim.temporal, maxRows);
  const colFold = colDim
    ? orderAndFold([...colAcc.keys()], colAcc, measure, !!colDim.temporal, maxCols)
    : { kept: [""], folded: [] };

  // Rebuild the accumulator grid onto the kept + fold buckets. Folding merges
  // accumulators (sets union), so distinct stays correct through the fold.
  const rowKeys = [...rowFold.kept];
  const colKeys = [...colFold.kept];
  const rowBucket = new Map<string, string>();
  for (const v of rowFold.kept) rowBucket.set(v, v);
  let rowFoldKey = "";
  if (rowFold.folded.length > 0) {
    rowFoldKey = foldLabel(!!rowDim.temporal, rowFold.folded.length);
    // A real dimension value could be named exactly like the fold bucket;
    // suffix until unique so the two never merge.
    while (rowFold.kept.includes(rowFoldKey)) rowFoldKey += " ";
    for (const v of rowFold.folded) rowBucket.set(v, rowFoldKey);
    if (rowDim.temporal) rowKeys.unshift(rowFoldKey);
    else rowKeys.push(rowFoldKey);
  }
  const colBucket = new Map<string, string>();
  for (const v of colFold.kept) colBucket.set(v, v);
  let colFoldKey = "";
  if (colDim && colFold.folded.length > 0) {
    colFoldKey = foldLabel(!!colDim.temporal, colFold.folded.length);
    while (colFold.kept.includes(colFoldKey)) colFoldKey += " ";
    for (const v of colFold.folded) colBucket.set(v, colFoldKey);
    if (colDim.temporal) colKeys.unshift(colFoldKey);
    else colKeys.push(colFoldKey);
  }

  const grid = new Map<string, Map<string, Acc>>();
  const rTot = new Map<string, Acc>();
  const cTot = new Map<string, Acc>();
  for (const [rv, byCol] of cellAcc) {
    const rk = rowBucket.get(rv)!;
    let gRow = grid.get(rk);
    if (!gRow) grid.set(rk, (gRow = new Map()));
    let rt = rTot.get(rk);
    if (!rt) rTot.set(rk, (rt = newAcc()));
    mergeAcc(rt, rowAcc.get(rv)!);
    for (const [cv, acc] of byCol) {
      const ck = colBucket.get(cv)!;
      let cell = gRow.get(ck);
      if (!cell) gRow.set(ck, (cell = newAcc()));
      mergeAcc(cell, acc);
    }
  }
  for (const [cv, acc] of colAcc) {
    const ck = colBucket.get(cv)!;
    let ct = cTot.get(ck);
    if (!ct) cTot.set(ck, (ct = newAcc()));
    mergeAcc(ct, acc);
  }

  return {
    rowLabels: rowKeys,
    colLabels: colDim ? colKeys : [measure.label],
    cells: rowKeys.map((rk) =>
      colKeys.map((ck) => {
        const acc = grid.get(rk)?.get(ck);
        return acc ? valueOf(acc, measure) : 0;
      }),
    ),
    rowTotals: rowKeys.map((rk) => valueOf(rTot.get(rk) ?? newAcc(), measure)),
    colTotals: colKeys.map((ck) => valueOf(cTot.get(ck) ?? newAcc(), measure)),
    grandTotal: valueOf(grand, measure),
    foldedRows: rowFold.folded.length,
    foldedCols: colFold.folded.length,
  };
}

/** "2026-08" for a date's month in the library's zone; matches monthKey in charts.tsx. */
export function isoMonth(d: Date | null | undefined): string | null {
  if (!d) return null;
  return zonedMonthKey(d);
}

/** "2026" for a date's year in the library's zone. */
export function isoYear(d: Date | null | undefined): string | null {
  return d ? zonedYearKey(d) : null;
}

/** "Ordered" from "ORDERED", "On loan" from "ON_LOAN". */
export function titleCase(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
