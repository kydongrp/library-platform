import { NextRequest, NextResponse } from "next/server";
import { getCurrentAdmin, canView } from "@/lib/admin-session";
import { toCsv } from "@/lib/reports";
import { getCube, parseRange } from "@/lib/flexi";
import { pivot } from "@/lib/flexi-core";

/**
 * FlexiReports CSV export: the same pivot the page renders, as an
 * Excel-compatible file. Money exports as plain decimal numbers (no currency
 * symbol) so the figures stay usable for further manipulation in Excel.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!canView(admin, "REPORTS")) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  const cube = getCube(params.get("cube") ?? "");
  if (!cube) {
    return new NextResponse("Unknown cube", { status: 400 });
  }

  const rowDim =
    cube.dimensions.find((d) => d.key === params.get("rows")) ??
    cube.dimensions.find((d) => d.key === cube.defaults.row) ??
    cube.dimensions[0];
  const colsParam = params.get("cols");
  let colDim =
    colsParam === "none"
      ? null
      : (cube.dimensions.find((d) => d.key === (colsParam ?? cube.defaults.col)) ?? null);
  if (colDim && colDim.key === rowDim.key) colDim = null;
  const measure =
    cube.measures.find((m) => m.key === params.get("measure")) ??
    cube.measures.find((m) => m.key === cube.defaults.measure) ??
    cube.measures[0];

  const data = await cube.fetch(
    parseRange(params.get("from") ?? undefined, params.get("to") ?? undefined),
  );
  const result = pivot(data, rowDim, colDim, measure, { maxRows: 5000, maxCols: 200 });

  const num = (v: number) => (measure.format === "money" ? (v / 100).toFixed(2) : String(v));
  const columns = [rowDim.label, ...result.colLabels, ...(colDim ? ["Total"] : [])];
  const rows = result.rowLabels.map((label, ri) => [
    label,
    ...result.cells[ri].map(num),
    ...(colDim ? [num(result.rowTotals[ri])] : []),
  ]);
  rows.push(["Total", ...result.colTotals.map(num), ...(colDim ? [num(result.grandTotal)] : [])]);

  const name = ["flexi", cube.key, rowDim.key, colDim?.key].filter(Boolean).join("-");
  // UTF-8 BOM so Excel opens the CSV with correct encoding.
  const csv = "﻿" + toCsv({ columns, rows });
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}.csv"`,
    },
  });
}
