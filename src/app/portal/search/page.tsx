import Link from "next/link";
import { prisma } from "@/lib/db";
import { ResourceCard } from "@/components/resource-card";
import { EmptyState } from "@/components/ui";
import { CATEGORIES, RESOURCE_TYPES, RESOURCE_TYPE_LABELS } from "@/lib/constants";
import { getCurrentMember } from "@/lib/session";

type SearchParams = Promise<{
  q?: string;
  category?: string;
  type?: string;
  availability?: string;
  sort?: string;
}>;

const cardSelect = {
  id: true, title: true, author: true, coverColor: true,
  type: true, category: true, digital: true, provider: true,
  copies: { select: { status: true } },
} as const;

const selectCls =
  "rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { q = "", category = "", type = "", availability = "", sort = "relevance" } =
    await searchParams;

  // Record search history (feeds "based on past searches" recommendations).
  if (q) {
    const member = await getCurrentMember();
    if (member) {
      const recent = await prisma.searchHistory.findFirst({
        where: { memberId: member.id, query: q },
        orderBy: { searchedAt: "desc" },
      });
      // Don't spam identical back-to-back searches (page reloads, filters).
      if (!recent || Date.now() - recent.searchedAt.getTime() > 60 * 60 * 1000) {
        await prisma.searchHistory.create({ data: { memberId: member.id, query: q } });
      }
    }
  }

  const where: Record<string, unknown> = {};
  if (q) {
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { author: { contains: q, mode: "insensitive" } },
      { isbn: { contains: q, mode: "insensitive" } },
      { description: { contains: q, mode: "insensitive" } },
    ];
  }
  if (category) where.category = category;
  if (type) where.type = type;
  if (availability === "digital") { where.digital = true; where.provider = null; }
  if (availability === "external") where.provider = { not: null };
  if (availability === "available") where.copies = { some: { status: "AVAILABLE" } };

  const orderBy =
    sort === "newest" ? { createdAt: "desc" as const }
    : sort === "author" ? { author: "asc" as const }
    : sort === "provider" ? { provider: "asc" as const }
    : { title: "asc" as const };

  let resources = await prisma.resource.findMany({ where, orderBy, select: cardSelect });

  // Rating sort needs the review aggregate (contract FR 8.1: sortable by rating).
  if (sort === "rating" && resources.length > 0) {
    const groups = await prisma.review.groupBy({
      by: ["resourceId"],
      where: { resourceId: { in: resources.map((r) => r.id) } },
      _avg: { rating: true },
    });
    const avg = new Map(groups.map((g) => [g.resourceId, g._avg.rating ?? 0]));
    resources = [...resources].sort((a, b) => (avg.get(b.id) ?? 0) - (avg.get(a.id) ?? 0));
  }

  const heading = q ? `Results for “${q}”` : category ? `${category}` : "Browse the collection";

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <h1 className="font-display text-3xl font-semibold">{heading}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {resources.length} title{resources.length === 1 ? "" : "s"}
      </p>

      {/* Filters */}
      <form className="mt-6 flex flex-wrap items-center gap-2">
        <input type="hidden" name="q" value={q} />
        <select name="category" defaultValue={category} className={selectCls}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select name="type" defaultValue={type} className={selectCls}>
          <option value="">All formats</option>
          {RESOURCE_TYPES.map((t) => <option key={t} value={t}>{RESOURCE_TYPE_LABELS[t]}</option>)}
        </select>
        <select name="availability" defaultValue={availability} className={selectCls}>
          <option value="">Any availability</option>
          <option value="available">Available now</option>
          <option value="digital">Digital / instant</option>
          <option value="external">Research databases</option>
        </select>
        <select name="sort" defaultValue={sort} className={selectCls}>
          <option value="relevance">Sort: Title</option>
          <option value="author">Sort: Author</option>
          <option value="newest">Sort: Newest</option>
          <option value="rating">Sort: Rating</option>
          <option value="provider">Sort: Provider</option>
        </select>
        <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
          Apply
        </button>
        {(category || type || availability || sort !== "relevance") && (
          <Link
            href={`/portal/search${q ? `?q=${encodeURIComponent(q)}` : ""}`}
            className="px-2 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            Reset
          </Link>
        )}
      </form>

      {resources.length === 0 ? (
        <div className="mt-10">
          <EmptyState
            title="No matches"
            description="Try broadening your search or clearing some filters."
            action={<Link href="/portal" className="text-primary hover:underline">← Back to browse</Link>}
          />
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-9 sm:grid-cols-3 lg:grid-cols-5">
          {resources.map((r) => (
            <ResourceCard key={r.id} resource={r} />
          ))}
        </div>
      )}
    </div>
  );
}
