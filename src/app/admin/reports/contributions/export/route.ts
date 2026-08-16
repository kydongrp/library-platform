import { NextResponse } from "next/server";
import { getCurrentAdmin, canView } from "@/lib/admin-session";
import { getContributionCsvRows } from "@/lib/contributions";

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
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
