import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticatePortalRequest } from "@/lib/portal-auth";
import { toPublicResource, publicResourceSelect } from "@/lib/portal-shapes";

// GET /api/portal/v1/editors-picks — the staff-curated shelf, newest pick first.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authenticatePortalRequest(request);
  if (!auth.ok) return auth.response;

  const picks = await prisma.resource.findMany({
    where: { editorsPick: true },
    select: publicResourceSelect,
    orderBy: { epPickedAt: { sort: "desc", nulls: "last" } },
  });

  return NextResponse.json({
    data: picks.map(toPublicResource),
    meta: { total: picks.length },
  });
}
