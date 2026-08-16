import { NextRequest, NextResponse } from "next/server";
import { getCurrentAdmin, canView } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { toMarcRecord, toMarcXml, toMarc2709 } from "@/lib/marc";
import { CATEGORIES, RESOURCE_TYPES } from "@/lib/constants";

// MARC 21 export of the catalogue (SDD: MARC exchange). Two formats:
//   ?format=xml  -> MARCXML collection (MARC21-slim)
//   ?format=mrc  -> binary ISO 2709
// Honours the catalogue page's filters (q / category / type / source).
export const dynamic = "force-dynamic";

const EXPORT_MAX = 10_000;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!canView(admin, "CATALOGUE")) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const p = req.nextUrl.searchParams;
  const format = p.get("format") === "mrc" ? "mrc" : "xml";
  const q = (p.get("q") ?? "").trim().slice(0, 200);
  const category = (p.get("category") ?? "").trim();
  const type = (p.get("type") ?? "").trim();
  const source = (p.get("source") ?? "").trim().slice(0, 80);

  const where: Record<string, unknown> = {};
  if (q) {
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { author: { contains: q, mode: "insensitive" } },
      { isbn: { contains: q, mode: "insensitive" } },
    ];
  }
  if (category && (CATEGORIES as readonly string[]).includes(category)) where.category = category;
  if (type && (RESOURCE_TYPES as readonly string[]).includes(type)) where.type = type;
  if (source === "local") where.provider = null;
  else if (source) where.provider = source;

  const resources = await prisma.resource.findMany({
    where,
    orderBy: { title: "asc" },
    take: EXPORT_MAX,
  });

  const records = resources.map(toMarcRecord);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filters = [q && `q=${q}`, category, type, source].filter(Boolean).join(", ");

  await audit({
    action: "catalogue.exportMarc",
    summary: `Exported ${records.length} record${records.length === 1 ? "" : "s"} as MARC 21 (${format.toUpperCase()})${filters ? ` — filters: ${filters}` : ""}`,
    entity: "Resource",
  });

  if (format === "mrc") {
    return new NextResponse(Buffer.from(toMarc2709(records)), {
      headers: {
        "Content-Type": "application/marc",
        "Content-Disposition": `attachment; filename="dls-marc-${stamp}.mrc"`,
      },
    });
  }
  return new NextResponse(toMarcXml(records), {
    headers: {
      "Content-Type": "application/marcxml+xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="dls-marc-${stamp}.xml"`,
    },
  });
}
