// COUNTER R5.1 usage-report parser. Pure (no Prisma, no Node APIs) so it can
// run in a server action and be exercised directly with tsx.
//
// Accepts the two shapes librarians actually have:
//  1. A standard COUNTER R5/R5.1 tabular report (TR/PR/DR/IR) as CSV or TSV:
//     a metadata preamble, then a header row containing Metric_Type and
//     monthly columns (Jan-2026 / 2026-01 / 2026-01-01).
//  2. A simple two-column sheet: period + count (header names are matched
//     loosely: month/period, count/requests/uses/total).
//
// Output is aggregated per (period, metric). Title-level rows are summed
// because the registry tracks provider-level usage for cost-per-use.

import { parseCsv } from "@/lib/bulk-import";

/** The metric cost-per-use is computed from (COUNTER's standard CPU metric). */
export const CPU_METRIC = "Total_Item_Requests";

// When a report carries the Requests metrics we keep just these two and drop
// Investigations/no-license noise; otherwise (e.g. a PR with only
// Searches_Platform) we keep whatever the report has and say so.
const PREFERRED_METRICS = new Set([CPU_METRIC, "Unique_Item_Requests"]);

const MAX_INPUT_CHARS = 4_000_000; // matches the 4MB server-action body limit
const MAX_MONTH_ROWS = 600; // 50 years of monthly figures; beyond this it's a bad file
const MAX_COUNT = 1_000_000_000;

export type UsageMonth = { period: string; metric: string; count: number };

export type CounterParseResult = {
  /** Aggregated monthly figures, one row per (period, metric), period-ascending. */
  months: UsageMonth[];
  reportName: string | null;
  /** Platform named in the report preamble, for cross-checking the chosen provider. */
  platform: string | null;
  rowsRead: number;
  warnings: string[];
};

const MONTH_NAMES: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Normalise a header/cell to "YYYY-MM"; null if it isn't a month. */
function periodOf(raw: string): string | null {
  const v = raw.trim().replace(/^"|"$/g, "");
  let m = /^([A-Za-z]{3})[-\s](\d{4})$/.exec(v); // Jan-2026 / Jan 2026
  if (m) {
    const mm = MONTH_NAMES[m[1].toLowerCase()];
    return mm ? `${m[2]}-${mm}` : null;
  }
  m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(v); // 2026-01 / 2026-01-01
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${m[2]}`;
  return null;
}

function countOf(raw: string): number | null {
  const v = raw.trim().replace(/^"|"$/g, "").replace(/,/g, "");
  if (!/^\d+$/.test(v)) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 && n <= MAX_COUNT ? n : null;
}

/** Split one TSV line (COUNTER TSVs don't quote fields). */
function tsvCells(line: string): string[] {
  return line.split("\t").map((c) => c.trim().replace(/^"|"$/g, ""));
}

export function parseCounterUsage(text: string): CounterParseResult {
  const warnings: string[] = [];
  if (text.length > MAX_INPUT_CHARS) {
    text = text.slice(0, MAX_INPUT_CHARS);
    warnings.push("File was larger than 4MB, so trailing rows were ignored.");
  }
  const src = text.replace(/^﻿/, "");
  const lines = src.split(/\r?\n/);

  // Locate the COUNTER table header (the row that names Metric_Type).
  const headerIdx = lines.findIndex((l) => /(^|[,\t])"?metric_type"?([,\t]|$)/i.test(l));

  let headers: string[];
  let dataRows: string[][];
  let reportName: string | null = null;
  let platform: string | null = null;

  if (headerIdx >= 0) {
    // Preamble metadata (Report_Name, Platform, …): two-cell lines above the table.
    for (const line of lines.slice(0, headerIdx)) {
      const cells = line.includes("\t") ? tsvCells(line) : parseCsvLine(line);
      const key = (cells[0] ?? "").toLowerCase();
      if (key === "report_name" && cells[1]) reportName = cells[1];
      if (key === "platform" && cells[1]) platform = cells[1];
    }
    const table = lines.slice(headerIdx);
    const isTsv = (table[0].match(/\t/g)?.length ?? 0) > (table[0].match(/,/g)?.length ?? 0);
    if (isTsv) {
      headers = tsvCells(table[0]);
      dataRows = table.slice(1).filter((l) => l.trim() !== "").map(tsvCells);
    } else {
      const parsed = parseCsv(table.join("\n"));
      headers = parsed.length ? Object.keys(parsed[0]) : tsvCells(table[0]);
      dataRows = parsed.map((r) => headers.map((h) => r[h] ?? ""));
    }
  } else {
    // Simple sheet: header row 0 with a period column and a count column.
    const isTsv = (lines[0]?.match(/\t/g)?.length ?? 0) > (lines[0]?.match(/,/g)?.length ?? 0);
    if (isTsv) {
      headers = tsvCells(lines[0] ?? "");
      dataRows = lines.slice(1).filter((l) => l.trim() !== "").map(tsvCells);
    } else {
      const parsed = parseCsv(src);
      headers = parsed.length ? Object.keys(parsed[0]) : [];
      dataRows = parsed.map((r) => headers.map((h) => r[h] ?? ""));
    }
    const lower = headers.map((h) => h.toLowerCase());
    const periodCol = lower.findIndex((h) => /^(period|month|date|yyyy-mm)$/.test(h));
    const countCol = lower.findIndex((h) => /(count|requests|uses|total|views|downloads)/.test(h));
    if (periodCol === -1 || countCol === -1) {
      return {
        months: [], reportName: null, platform: null, rowsRead: 0,
        warnings: [
          "Not a recognisable usage file. Expected a COUNTER R5/R5.1 report (a header row containing Metric_Type) or a simple sheet with period and count columns.",
        ],
      };
    }
    const totals = new Map<string, number>();
    let rowsRead = 0;
    let skipped = 0;
    for (const cells of dataRows) {
      const period = periodOf(cells[periodCol] ?? "");
      const count = countOf(cells[countCol] ?? "");
      if (!period || count == null) { skipped++; continue; }
      rowsRead++;
      const key = `${period}|${CPU_METRIC}`;
      totals.set(key, (totals.get(key) ?? 0) + count);
    }
    if (skipped > 0) warnings.push(`${skipped} row${skipped === 1 ? "" : "s"} skipped (unreadable period or count).`);
    return { months: toMonths(totals, warnings), reportName: null, platform: null, rowsRead, warnings };
  }

  // COUNTER table: metric column + month columns.
  const metricCol = headers.findIndex((h) => h.trim().toLowerCase() === "metric_type");
  const monthCols = headers
    .map((h, i) => ({ period: periodOf(h), i }))
    .filter((c): c is { period: string; i: number } => c.period != null);
  if (monthCols.length === 0) {
    return {
      months: [], reportName, platform, rowsRead: 0,
      warnings: [
        "The COUNTER report has no monthly columns (Reporting_Period_Total only). Re-run the report with monthly granularity, or use the simple period,count format.",
        ...warnings,
      ],
    };
  }

  const metricsSeen = new Set<string>();
  for (const cells of dataRows) {
    const metric = (cells[metricCol] ?? "").trim();
    if (metric) metricsSeen.add(metric);
  }
  const hasPreferred = [...metricsSeen].some((m) => PREFERRED_METRICS.has(m));
  const keep = hasPreferred ? PREFERRED_METRICS : metricsSeen;
  if (hasPreferred && metricsSeen.size > 2) {
    const dropped = [...metricsSeen].filter((m) => !PREFERRED_METRICS.has(m));
    warnings.push(`Kept Total_Item_Requests and Unique_Item_Requests; ignored ${dropped.length} other metric type${dropped.length === 1 ? "" : "s"} (${dropped.slice(0, 3).join(", ")}${dropped.length > 3 ? "…" : ""}).`);
  }
  if (!hasPreferred && metricsSeen.size > 0) {
    warnings.push("No Total_Item_Requests rows in this report; imported the metrics it does have. Cost-per-use needs Total_Item_Requests (a TR report).");
  }

  const totals = new Map<string, number>();
  let rowsRead = 0;
  for (const cells of dataRows) {
    const metric = (cells[metricCol] ?? "").trim();
    if (!metric || !keep.has(metric)) continue;
    rowsRead++;
    for (const { period, i } of monthCols) {
      const count = countOf(cells[i] ?? "");
      if (count == null || count === 0) continue;
      const key = `${period}|${metric}`;
      totals.set(key, (totals.get(key) ?? 0) + count);
    }
  }

  return { months: toMonths(totals, warnings), reportName, platform, rowsRead, warnings };
}

function toMonths(totals: Map<string, number>, warnings: string[]): UsageMonth[] {
  let months = [...totals.entries()]
    .map(([key, count]) => {
      const [period, metric] = key.split("|");
      return { period, metric, count: Math.min(count, MAX_COUNT) };
    })
    .sort((a, b) => a.period.localeCompare(b.period) || a.metric.localeCompare(b.metric));
  if (months.length > MAX_MONTH_ROWS) {
    warnings.push(`Report spans an implausible range; kept the most recent ${MAX_MONTH_ROWS} monthly figures.`);
    months = months.slice(-MAX_MONTH_ROWS);
  }
  return months;
}

// Single-line CSV split for preamble lines (they never contain embedded newlines).
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { cells.push(field.trim()); field = ""; }
    else field += ch;
  }
  cells.push(field.trim());
  return cells;
}
