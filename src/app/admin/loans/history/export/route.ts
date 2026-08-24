import { zonedDayKey } from "@/lib/tz";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentAdmin, canView } from "@/lib/admin-session";
import { getLoanHistory, HISTORY_EXPORT_MAX } from "@/lib/loan-history";
import { audit } from "@/lib/audit";

// CSV of the filtered loan history (mirrors the audit-trail export pattern).
export const dynamic = "force-dynamic";

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// The Singapore calendar day, not the UTC one: a loan returned at
// 01:30 was exported as the previous date.
const iso = (d: Date | null) => (d ? zonedDayKey(d) : "");

export async function GET(req: NextRequest): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!canView(admin, "LOANS")) return new NextResponse("Forbidden", { status: 403 });

  const p = req.nextUrl.searchParams;
  const filters = {
    q: (p.get("q") ?? "").trim().slice(0, 200),
    returnStatus: p.get("returnStatus") ?? "",
    condition: p.get("condition") ?? "",
    fine: p.get("fine") ?? "",
    from: p.get("from") ?? "",
    to: p.get("to") ?? "",
  };

  const { rows, totals } = await getLoanHistory(filters, 1, HISTORY_EXPORT_MAX);

  const header = [
    "title", "barcode", "member", "borrowedAt", "dueAt", "returnedAt",
    "returnStatus", "condition", "renewals", "returnedBy",
    "fine", "fineState", "fineNote",
  ];
  const lines = rows.map((r) =>
    [
      r.title,
      r.barcode ?? "",
      r.memberName,
      iso(r.borrowedAt),
      iso(r.dueAt),
      iso(r.returnedAt),
      r.returnStatus,
      r.returnCondition,
      r.renewals,
      r.returnedBy ?? "",
      (r.fineCents / 100).toFixed(2),
      r.fineCents === 0 ? "none" : r.finePaidAt ? "paid" : r.fineWaivedAt ? "waived" : "outstanding",
      r.fineNote ?? "",
    ]
      .map(csvCell)
      .join(","),
  );

  await audit({
    action: "circulation.historyExport",
    summary: `Exported ${rows.length} loan history row${rows.length === 1 ? "" : "s"} (${(totals.finesAssessedCents / 100).toFixed(2)} in fines assessed)`,
    entity: "Loan",
  });

  // UTF-8 BOM so Excel opens it with the right encoding.
  const csv = "﻿" + [header.join(","), ...lines].join("\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="loan-history-${zonedDayKey(new Date())}.csv"`,
    },
  });
}
