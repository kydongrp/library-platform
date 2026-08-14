import { NextRequest, NextResponse } from "next/server";
import { getCurrentAdmin, canView } from "@/lib/admin-session";
import { prisma } from "@/lib/db";

const EXPORT_MAX = 10_000;

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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

  // UTF-8 BOM so Excel opens the CSV with correct encoding.
  const csv = "﻿" + [header.join(","), ...rows].join("\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-trail.csv"`,
    },
  });
}
