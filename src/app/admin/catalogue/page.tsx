import { requireAdminView } from "@/lib/admin-guard";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, Badge, ButtonLink, BookCover, EmptyState } from "@/components/ui";
import {
  CATEGORIES,
  RESOURCE_TYPES,
  RESOURCE_TYPE_LABELS,
} from "@/lib/constants";
import { availability } from "@/lib/availability";

type SearchParams = Promise<{ q?: string; category?: string; type?: string; source?: string }>;

const inputCls =
  "rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

export default async function CataloguePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireAdminView("CATALOGUE");

  const { q = "", category = "", type = "", source = "" } = await searchParams;

  const where: Record<string, unknown> = {};
  if (q) {
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { author: { contains: q, mode: "insensitive" } },
      { isbn: { contains: q, mode: "insensitive" } },
    ];
  }
  if (category) where.category = category;
  if (type) where.type = type;
  if (source === "local") where.provider = null;
  else if (source) where.provider = source;

  const [resources, providerRows] = await Promise.all([
    prisma.resource.findMany({
      where,
      include: { copies: true },
      orderBy: { title: "asc" },
    }),
    prisma.resource.findMany({
      where: { provider: { not: null } },
      distinct: ["provider"],
      select: { provider: true },
      orderBy: { provider: "asc" },
    }),
  ]);
  const providers = providerRows.map((r) => r.provider!).filter(Boolean);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Catalogue</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {resources.length} title{resources.length === 1 ? "" : "s"}
            {(q || category || type) && " matching your filters"}.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* MARC 21 export honours the active filters (SDD: MARC exchange). */}
          <ButtonLink
            href={`/admin/catalogue/export?${new URLSearchParams({ format: "xml", q, category, type, source })}`}
            variant="ghost"
            className="text-xs"
          >
            ⇑ MARC XML
          </ButtonLink>
          <ButtonLink
            href={`/admin/catalogue/export?${new URLSearchParams({ format: "mrc", q, category, type, source })}`}
            variant="ghost"
            className="text-xs"
          >
            ⇑ MARC .mrc
          </ButtonLink>
          <ButtonLink href="/admin/catalogue/import" variant="outline">⇩ LiveFetch import</ButtonLink>
          <ButtonLink href="/admin/catalogue/new">+ Add title</ButtonLink>
        </div>
      </div>

      {/* Filters */}
      <form className="mb-6 flex flex-wrap items-center gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search title, author, ISBN…"
          className={`${inputCls} min-w-56 flex-1`}
        />
        <select name="category" defaultValue={category} className={inputCls}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select name="type" defaultValue={type} className={inputCls}>
          <option value="">All types</option>
          {RESOURCE_TYPES.map((t) => (
            <option key={t} value={t}>{RESOURCE_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <select name="source" defaultValue={source} className={inputCls}>
          <option value="">All sources</option>
          <option value="local">Local collection</option>
          {providers.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
          Filter
        </button>
        {(q || category || type || source) && (
          <Link href="/admin/catalogue" className="px-2 py-2 text-sm text-muted-foreground hover:text-foreground">
            Clear
          </Link>
        )}
      </form>

      {resources.length === 0 ? (
        <EmptyState
          title="No titles found"
          description="Try a different search, or add a new title to the catalogue."
          action={<ButtonLink href="/admin/catalogue/new">+ Add title</ButtonLink>}
        />
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {resources.map((r) => {
            const avail = availability(r);
            const tone =
              avail.state === "digital" || avail.state === "external" ? "primary"
              : avail.state === "available" ? "success"
              : "danger";
            return (
              <Link
                key={r.id}
                href={`/admin/catalogue/${r.id}`}
                className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/50"
              >
                <BookCover title={r.title} author={r.author} color={r.coverColor} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{r.title}</p>
                  <p className="truncate text-sm text-muted-foreground">{r.author}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone="neutral">{RESOURCE_TYPE_LABELS[r.type] ?? r.type}</Badge>
                    <Badge tone="muted">{r.category}</Badge>
                    {r.provider && <Badge tone="accent">{r.provider}</Badge>}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <Badge tone={tone}>{avail.label}</Badge>
                  {avail.state !== "digital" && avail.state !== "external" && (
                    <p className="mt-1 text-xs text-muted-foreground">{r.copies.length} copies</p>
                  )}
                </div>
              </Link>
            );
          })}
        </Card>
      )}
    </div>
  );
}
