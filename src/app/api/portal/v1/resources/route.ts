import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { bibSearchWhere } from "@/lib/search-config";
import { authenticatePortalRequest, apiError } from "@/lib/portal-auth";
import { toPublicResource, publicResourceSelect } from "@/lib/portal-shapes";
import { CATEGORIES, RESOURCE_TYPES } from "@/lib/constants";

// GET /api/portal/v1/resources: catalogue search for the Learner Portal.
// Query: q, category, type, provider, updatedSince (ISO), sort=newest|title|updated,
//        page (1-based), pageSize (max 100).
export const dynamic = "force-dynamic";

const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 10_000;

export async function GET(request: Request) {
  const auth = await authenticatePortalRequest(request);
  if (!auth.ok) return auth.response;

  const p = new URL(request.url).searchParams;
  const q = (p.get("q") ?? "").trim().slice(0, 200);
  const category = (p.get("category") ?? "").trim();
  const type = (p.get("type") ?? "").trim().toUpperCase();
  const provider = (p.get("provider") ?? "").trim().slice(0, 80);
  const updatedSinceRaw = (p.get("updatedSince") ?? "").trim();
  const sort = p.get("sort") ?? "newest";

  if (category && !(CATEGORIES as readonly string[]).includes(category))
    return apiError(400, "bad_category", `Unknown category. One of: ${CATEGORIES.join(", ")}.`);
  if (type && !(RESOURCE_TYPES as readonly string[]).includes(type))
    return apiError(400, "bad_type", `Unknown type. One of: ${RESOURCE_TYPES.join(", ")}.`);
  let updatedSince: Date | null = null;
  if (updatedSinceRaw) {
    updatedSince = new Date(updatedSinceRaw);
    if (Number.isNaN(updatedSince.getTime()))
      return apiError(400, "bad_updated_since", "updatedSince must be an ISO 8601 timestamp.");
  }
  if (!["newest", "title", "updated"].includes(sort))
    return apiError(400, "bad_sort", "sort must be one of: newest, title, updated.");

  const page = Math.min(Math.max(parseInt(p.get("page") ?? "1", 10) || 1, 1), MAX_PAGE);
  const pageSize = Math.min(Math.max(parseInt(p.get("pageSize") ?? "20", 10) || 20, 1), MAX_PAGE_SIZE);

  const where: Record<string, unknown> = {};
  if (q) {
    // Token search with stop words dropped and variant spellings expanded.
    Object.assign(where, await bibSearchWhere(q, ["title", "author", "isbn", "publisher"]));
  }
  if (category) where.category = category;
  if (type) where.type = type;
  if (provider) where.provider = provider;
  if (updatedSince) where.updatedAt = { gte: updatedSince };

  const orderBy =
    sort === "title"
      ? { title: "asc" as const }
      : sort === "updated"
        ? { updatedAt: "desc" as const }
        : { createdAt: "desc" as const };

  const [rows, total] = await Promise.all([
    prisma.resource.findMany({
      where,
      select: publicResourceSelect,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.resource.count({ where }),
  ]);

  return NextResponse.json({
    data: rows.map(toPublicResource),
    meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  });
}
