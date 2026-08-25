import { NextRequest, NextResponse } from "next/server";
import { getCurrentAdmin, canView } from "@/lib/admin-session";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";

const EXPORT_MAX = 10_000;

// Mirrors toCsv() in src/lib/reports.ts: a leading =, +, -, @, tab, or CR
// executes as a formula when the CSV opens in a spreadsheet, so such cells are
// prefixed with a quote unless they are plain numbers.
const PLAIN_NUMBER = /^-?\$?[\d,]+(\.\d+)?%?$/;
function csvCell(v: unknown): string {
  const raw = v == null ? "" : String(v);
  const s = /^[=+@\t\r-]/.test(raw) && !PLAIN_NUMBER.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!canView(admin, "ADMIN")) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  const family = params.get("family") ?? "";
  const actor = params.get("actor") ?? "";
  const q = params.get("q") ?? "";

  const entries = await prisma.auditLog.findMany({
    where: {
      ...(family ? { action: { startsWith: family + "." } } : {}),
      ...(actor ? { actor } : {}),
      ...(q ? { summary: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: { at: "desc" },
    take: EXPORT_MAX,
  });

  const header = ["at", "actor", "action", "entity", "entityId", "summary", "detail"];
  const rows = entries.map((e) =>
    [
      e.at.toISOString(),
      e.actor,
      e.action,
      e.entity ?? "",
      e.entityId ?? "",
      e.summary,
      e.detail != null ? JSON.stringify(e.detail) : "",
    ]
      .map(csvCell)
      .join(","),
  );

  // Downloading the trail is itself an accountable act: unlike viewing, an
  // export leaves the building, so it gets its own audit row.
  await audit({
    action: "audit.export",
    summary: `Exported ${entries.length} audit rows${family ? ` (family ${family})` : ""}${actor ? ` (actor ${actor})` : ""}`,
    entity: "AuditLog",
    detail: { rows: entries.length, family: family || null, actor: actor || null, q: q || null },
  });

  // UTF-8 BOM so Excel opens the CSV with correct encoding.
  const csv = "﻿" + [header.join(","), ...rows].join("\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-trail.csv"`,
    },
  });
}
