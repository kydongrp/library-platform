import { NextResponse } from "next/server";
import { getCurrentAdmin, canView } from "@/lib/admin-session";
import { getContributionCsvRows } from "@/lib/contributions";

// Mirrors toCsv() in src/lib/reports.ts: formula-leading cells are neutralised.
const PLAIN_NUMBER = /^-?\$?[\d,]+(\.\d+)?%?$/;
function csvCell(v: string): string {
  const s = /^[=+@\t\r-]/.test(v) && !PLAIN_NUMBER.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!canView(admin, "REPORTS")) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const rows = await getContributionCsvRows();
  // UTF-8 BOM so Excel opens the CSV with correct encoding.
  const csv = "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="staff-contributions.csv"`,
    },
  });
}
