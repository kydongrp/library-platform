import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticatePortalRequest, apiError } from "@/lib/portal-auth";
import { toPublicResource, publicResourceSelect } from "@/lib/portal-shapes";
import { linkStatesFor } from "@/lib/linkcheck";

// GET /api/portal/v1/resources/:id. Full record + aggregate rating.
// Only aggregates leave the system: individual reviews carry member identity.
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticatePortalRequest(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const [resource, rating] = await Promise.all([
    prisma.resource.findUnique({ where: { id }, select: publicResourceSelect }),
    prisma.review.aggregate({
      where: { resourceId: id },
      _avg: { rating: true },
      _count: { _all: true },
    }),
  ]);
  if (!resource) return apiError(404, "not_found", "No resource with that id.");

  return NextResponse.json({
    data: {
      ...toPublicResource(resource, (await linkStatesFor([resource.id])).get(resource.id) ?? null),
      rating:
        rating._count._all > 0
          ? { average: Math.round((rating._avg.rating ?? 0) * 10) / 10, count: rating._count._all }
          : null,
    },
  });
}
