import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { SOURCES, searchScholarly, xploreConfigured, MANUAL_PROVIDERS, type ScholarlyRecord, type SourceKey } from "@/lib/scholarly";
import { ImportButton, ImportAllBar, ManualArticleForm, BulkImportForm } from "./widgets";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ source?: string; q?: string }>;

export default async function LiveFetchPage({ searchParams }: { searchParams: SearchParams }) {
  const admin = await requireAdminView("CATALOGUE");
  const editable = canEdit(admin, "CATALOGUE");

  const { source = "ieee", q = "" } = await searchParams;
  const sourceKey = (SOURCES.some((s) => s.key === source) ? source : "ieee") as SourceKey;
  const isManual = sourceKey === "manual";
  const isBulk = sourceKey === "bulk";
  const isSearch = !isManual && !isBulk;

  let records: ScholarlyRecord[] = [];
  let searchError: string | null = null;
  if (q && isSearch) {
    try {
      records = await searchScholarly(sourceKey, q);
    } catch (e) {
      searchError = e instanceof Error ? e.message : "Search failed.";
    }
  }

  // Flag records already in the catalogue so staff see what's new.
  const inCatalogue = new Set<string>();
  if (records.length > 0) {
    const urls = records.flatMap((r) => [r.url, ...(r.oaUrl ? [r.oaUrl] : [])]);
    const existing = await prisma.resource.findMany({
      where: { digitalUrl: { in: urls } },
      select: { digitalUrl: true },
    });
    const existingUrls = new Set(existing.map((e) => e.digitalUrl));
    for (const r of records) {
      if (existingUrls.has(r.url) || (r.oaUrl && existingUrls.has(r.oaUrl))) {
        inCatalogue.add(r.externalId);
      }
    }
  }
  const importable = records.filter((r) => !inCatalogue.has(r.externalId));

  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/admin/catalogue" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back to catalogue
      </Link>
      <div className="mb-6 mt-2">
        <h1 className="font-display text-3xl font-semibold">LiveFetch — Scholarly Import</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Search external publication sources and import records straight into the
          catalogue. Imported titles link out to the publisher (or the open-access full
          text when one exists), just like the IEEE content already in the collection.
        </p>
      </div>

      {/* Source picker */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SOURCES.map((s) => {
          const disabled = s.key === "xplore" && !xploreConfigured();
          const card = (
            <div
              className={`h-full rounded-xl border p-4 shadow-sm transition-all ${
                sourceKey === s.key && !disabled
                  ? "border-primary bg-primary/5"
                  : "border-border bg-card"
              } ${disabled ? "opacity-50" : "hover:-translate-y-0.5 hover:shadow-md"}`}
            >
              <p className="text-sm font-semibold">{s.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {disabled ? "Set IEEE_API_KEY in the environment to enable." : s.description}
              </p>
            </div>
          );
          return disabled ? (
            <div key={s.key}>{card}</div>
          ) : (
            <Link key={s.key} href={`/admin/catalogue/import?source=${s.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}>
              {card}
            </Link>
          );
        })}
      </div>

      {isManual || isBulk ? (
        !editable ? (
          <EmptyState title="Read-only access" description="Your group can view the catalogue but not add to it." />
        ) : isBulk ? (
          <BulkImportForm providers={MANUAL_PROVIDERS} />
        ) : (
          <ManualArticleForm providers={MANUAL_PROVIDERS} />
        )
      ) : (
      <>
      {/* Search */}
      <form className="mb-6 flex flex-wrap gap-2">
        <input type="hidden" name="source" value={sourceKey} />
        <input
          name="q"
          defaultValue={q}
          placeholder="Search topic, title, author… e.g. federated learning"
          className="min-w-72 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
        <button type="submit" className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
          Search
        </button>
      </form>

      {searchError ? (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {searchError} — external source may be unreachable; try again or switch source.
        </p>
      ) : !q ? (
        <EmptyState
          title="Search a scholarly source"
          description="Try “transformer architectures”, “power systems stability”, or an author name. Results import as digital resources with provider link-outs."
        />
      ) : records.length === 0 ? (
        <EmptyState title="No results" description="Try different keywords or another source." />
      ) : (
        <>
          {editable && importable.length > 0 && (
            <ImportAllBar records={importable} count={importable.length} />
          )}
          <Card className="divide-y divide-border overflow-hidden">
            {records.map((r) => {
              const dup = inCatalogue.has(r.externalId);
              return (
                <div key={r.externalId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium leading-snug">{r.title}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {r.authors}
                      {r.year ? ` · ${r.year}` : ""}
                      {r.venue ? ` · ${r.venue}` : ""}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {r.publisher && <Badge tone="neutral">{r.publisher}</Badge>}
                      <Badge tone="muted">{r.type.toLowerCase()}</Badge>
                      {r.oaUrl && <Badge tone="success">open access</Badge>}
                      <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">
                        preview ↗
                      </a>
                    </div>
                  </div>
                  {dup ? (
                    <Badge tone="primary">✓ in catalogue</Badge>
                  ) : editable ? (
                    <ImportButton record={r} />
                  ) : null}
                </div>
              );
            })}
          </Card>
        </>
      )}
      </>
      )}
    </div>
  );
}
