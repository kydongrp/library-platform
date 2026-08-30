import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { deleteCodeRow } from "@/app/actions/items";
import { COPY_STATUSES, COPY_STATUS_LABELS } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import { resolvePaging } from "@/lib/paging";
import { TablePager } from "@/components/pagination";
import {
  ItemsTable, CollectionForm, LocationForm, ItemTypeForm,
} from "./widgets";

export const dynamic = "force-dynamic";

/**
 * A shelf list is scanned rather than read, so this defaults denser than a
 * report. It must be one of PAGE_SIZES, or the dropdown could not show it as
 * selected.
 */
const ITEMS_PER_PAGE = 100;

type SearchParams = Promise<{
  q?: string; status?: string; collection?: string; location?: string; itemType?: string;
  page?: string; pageSize?: string;
}>;

export default async function ItemsPage({ searchParams }: { searchParams: SearchParams }) {
  const admin = await requireAdminView("CATALOGUE");
  const editable = canEdit(admin, "CATALOGUE");
  const sp = await searchParams;

  const q = (sp.q ?? "").trim();
  const where: Record<string, unknown> = {};
  if (q) {
    where.OR = [
      { barcode: { contains: q, mode: "insensitive" } },
      { resource: { title: { contains: q, mode: "insensitive" } } },
    ];
  }
  if (sp.status && (COPY_STATUSES as readonly string[]).includes(sp.status)) where.status = sp.status;
  if (sp.collection) where.collectionId = sp.collection;
  if (sp.location) where.locationId = sp.location;
  if (sp.itemType) where.itemTypeId = sp.itemType;

  // The count has to come first: `skip` cannot be computed until the total is
  // known, because a page past the end must clamp to the last page rather than
  // return nothing. Everything that does not depend on paging runs alongside
  // it, so this is two round trips rather than one, not seven.
  const [total, collections, locations, itemTypes, weedLog, statusCounts] = await Promise.all([
    prisma.copy.count({ where }),
    prisma.itemCollection.findMany({ orderBy: { code: "asc" }, include: { _count: { select: { copies: true } } } }),
    prisma.itemLocation.findMany({ orderBy: { code: "asc" }, include: { _count: { select: { copies: true } } } }),
    prisma.itemType.findMany({ orderBy: { code: "asc" }, include: { _count: { select: { copies: true } } } }),
    prisma.itemWeedLog.findMany({ orderBy: { weededAt: "desc" }, take: 15 }),
    prisma.copy.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const paging = resolvePaging(total, sp.page, sp.pageSize, ITEMS_PER_PAGE);

  // Paged at the database, not in memory. This page used to take the first 200
  // and say so, which meant item 201 could not be reached from the interface at
  // all: the rows existed and there was no way to ask for them.
  //
  // The order must be total, or two pages could show the same row and skip
  // another. Barcode is unique, so it is a complete ordering on its own.
  const copies = await prisma.copy.findMany({
    where,
    include: {
      resource: { select: { id: true, title: true } },
      collection: { select: { code: true, name: true } },
      itemLocation: { select: { code: true, name: true } },
      itemType: { select: { code: true, name: true } },
      loans: {
        where: { status: "ACTIVE" },
        select: { member: { select: { name: true } } },
        take: 1,
      },
    },
    orderBy: { barcode: "asc" },
    skip: paging.start,
    take: paging.pageSize,
  });

  const countBy = new Map(statusCounts.map((s) => [s.status, s._count._all]));
  const inputCls =
    "rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

  const items = copies.map((c) => ({
    id: c.id,
    barcode: c.barcode,
    title: c.resource.title,
    resourceId: c.resource.id,
    status: c.status,
    collection: c.collection ? `${c.collection.code} · ${c.collection.name}` : null,
    // Fall back to the legacy free-text shelf when no location code is set.
    location: c.itemLocation ? `${c.itemLocation.code} · ${c.itemLocation.name}` : c.location || null,
    itemType: c.itemType ? `${c.itemType.code} · ${c.itemType.name}` : null,
    onLoanTo: c.loans[0]?.member.name ?? null,
  }));

  const opts = (rows: { id: string; code: string; name: string }[]) =>
    rows.map((r) => ({ id: r.id, code: r.code, name: r.name }));

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
        <h1 className="font-display text-3xl font-semibold">Items</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Every barcoded copy in the collection, with the codes that describe
          it. Item type drives the loan policy matrix (member type × item type),
          collections can cap how many a member holds at once, and weeding is
          logged rather than silently deleting history.
        </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/items/stocktake"
            className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            ▦ Stocktake
          </Link>
          <Link
            href="/admin/items/import"
            className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            ⇪ Import items
          </Link>
        </div>
      </div>

      {/* Status summary */}
      <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {COPY_STATUSES.map((s) => (
          <Link key={s} href={`/admin/items?status=${s}`}
            className="rounded-xl border border-border bg-card p-3 shadow-sm transition-colors hover:bg-muted/50">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">{COPY_STATUS_LABELS[s]}</dt>
            <dd className="mt-0.5 font-display text-xl font-semibold" style={{ fontVariantNumeric: "tabular-nums" }}>
              {countBy.get(s) ?? 0}
            </dd>
          </Link>
        ))}
      </dl>

      {/* Filters */}
      <form className="mb-4 flex flex-wrap items-center gap-2">
        {/* Carry the rows-per-page choice through a filter change; `page` is
            deliberately not carried, because a new filter is a new result set
            and page 8 of the old one means nothing. */}
        {paging.pageSize !== ITEMS_PER_PAGE && (
          <input type="hidden" name="pageSize" value={paging.pageSize} />
        )}
        <input name="q" defaultValue={q} placeholder="Barcode or title…"
          className={`min-w-52 flex-1 ${inputCls}`} />
        <select name="status" defaultValue={sp.status ?? ""} className={inputCls} aria-label="Status">
          <option value="">All statuses</option>
          {COPY_STATUSES.map((s) => <option key={s} value={s}>{COPY_STATUS_LABELS[s]}</option>)}
        </select>
        <select name="collection" defaultValue={sp.collection ?? ""} className={inputCls} aria-label="Collection">
          <option value="">All collections</option>
          {collections.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
        </select>
        <select name="location" defaultValue={sp.location ?? ""} className={inputCls} aria-label="Location">
          <option value="">All locations</option>
          {locations.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
        </select>
        <select name="itemType" defaultValue={sp.itemType ?? ""} className={inputCls} aria-label="Item type">
          <option value="">All item types</option>
          {itemTypes.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
        </select>
        <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
          Filter
        </button>
        {(q || sp.status || sp.collection || sp.location || sp.itemType) && (
          <Link href="/admin/items" className="px-2 py-2 text-sm text-muted-foreground hover:text-foreground">Clear</Link>
        )}
      </form>

      <p className="mb-2 text-xs text-muted-foreground">
        {total.toLocaleString()} item{total === 1 ? "" : "s"} match.
        {editable && " Tick rows to change properties or weed them."}
        {editable && paging.totalPages > 1 && " A selection applies to this page only."}
      </p>

      {items.length === 0 ? (
        <EmptyState title="No items match" description="Adjust the filters, or add copies from a catalogue record." />
      ) : (
        <>
          <ItemsTable
            items={items}
            collections={opts(collections)}
            locations={opts(locations)}
            itemTypes={opts(itemTypes)}
            editable={editable}
          />
          <TablePager
            paging={paging}
            query={{
              q,
              status: sp.status,
              collection: sp.collection,
              location: sp.location,
              itemType: sp.itemType,
            }}
            basePath="/admin/items"
            unit="items"
            defaultPageSize={ITEMS_PER_PAGE}
            className="mt-4"
          />
        </>
      )}

      {/* Code lists */}
      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        {([
          { title: "Collections", rows: collections, kind: "collection", form: <CollectionForm />,
            hint: "Groups items for shelving and can cap concurrent loans." },
          { title: "Locations", rows: locations, kind: "location", form: <LocationForm />,
            hint: "Where a copy physically lives." },
          { title: "Item types", rows: itemTypes, kind: "itemType", form: <ItemTypeForm />,
            hint: "Drives the loan policy matrix. Non-loanable = reference only; an hourly period circulates by the hour." },
        ] as const).map((list) => (
          <Card key={list.title} className="p-5">
            <h2 className="mb-1 font-display text-lg font-semibold">{list.title}</h2>
            <p className="mb-3 text-xs text-muted-foreground">{list.hint}</p>
            {list.rows.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">None yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {list.rows.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm">
                        <span className="font-mono text-xs font-semibold">{r.code}</span> · {r.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {r._count.copies} item{r._count.copies === 1 ? "" : "s"}
                        {"loanLimitOverride" in r && r.loanLimitOverride != null && ` · max ${r.loanLimitOverride} per member`}
                        {"loanable" in r && !r.loanable && " · reference only"}
                        {"loanHours" in r && r.loanHours ? ` · ${r.loanHours}h loan` : ""}
                      </p>
                    </div>
                    {editable && (
                      <ActionButton action={deleteCodeRow} fields={{ kind: list.kind, id: r.id }}
                        variant="ghost" className="!px-2 !py-1 text-xs text-red-700" pendingLabel="…"
                        confirm={`Delete ${r.code}? Items keep their other details.`}>
                        Delete
                      </ActionButton>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {editable && <div className="mt-3 border-t border-border pt-3">{list.form}</div>}
          </Card>
        ))}
      </div>

      {/* Weeding log */}
      <Card className="mt-6 p-5">
        <h2 className="mb-1 font-display text-lg font-semibold">Weeding log</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Copies removed from the collection. Loan history survives weeding; only the copy record goes.
        </p>
        {weedLog.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">Nothing weeded yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {weedLog.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    <span className="font-mono text-xs">{w.barcode}</span> · {w.title}
                  </p>
                  <p className="text-xs text-muted-foreground">{w.reason}</p>
                </div>
                <span className="text-xs text-muted-foreground">
                  {w.weededBy} · {formatDate(w.weededAt)}
                  {w.collection && <Badge tone="muted">{w.collection}</Badge>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
