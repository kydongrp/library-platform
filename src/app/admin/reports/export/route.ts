import { NextRequest, NextResponse } from "next/server";
import { getCurrentAdmin, canView } from "@/lib/admin-session";
import { runReport, toCsv, REPORTS } from "@/lib/reports";
import { MODULE_REPORTS } from "@/lib/reports-modules";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!canView(admin, "REPORTS")) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  const key = params.get("report") ?? "";
  const known = [...REPORTS, ...MODULE_REPORTS].some((r) => r.key === key);
  if (!known) {
    return new NextResponse("Unknown report", { status: 400 });
  }

  const result = await runReport(key, {
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    memberType: params.get("memberType") ?? undefined,
  });

  // UTF-8 BOM so Excel opens the CSV with correct encoding.
  const csv = "﻿" + toCsv(result);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${key}-report.csv"`,
    },
  });
}
