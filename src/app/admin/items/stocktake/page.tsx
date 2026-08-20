import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { NewStocktakeForm } from "./widgets";

export const dynamic = "force-dynamic";

type Summary = {
  found?: number;
  missing?: number;
  misplaced?: number;
  unexpected?: number;
  markedLost?: number;
} | null;

export default async function StocktakeListPage() {
  const admin = await requireAdminView("CATALOGUE");
  const editable = canEdit(admin, "CATALOGUE");

  const [stocktakes, collections, locations] = await Promise.all([
    prisma.stocktake.findMany({
      include: {
        collection: { select: { code: true, name: true } },
        location: { select: { code: true, name: true } },
        _count: { select: { scans: true } },
      },
      orderBy: { startedAt: "desc" },
      take: 50,
    }),
    prisma.itemCollection.findMany({ orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    prisma.itemLocation.findMany({ orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
  ]);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Stocktake</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Track item records against the physical shelves. Open a stocktake for a slice of the
          collection, scan every barcode on the shelf, and close it to freeze the count. Items on
          loan are expected to be absent; everything else unscanned is reported missing.
        </p>
        <p className="mt-2 text-sm">
          <Link href="/admin/items" className="text-primary hover:underline">← Back to Items</Link>
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div>
          {stocktakes.length === 0 ? (
            <EmptyState
              title="No stocktakes yet"
              description="Open one to start counting a collection, a location, or the whole library."
            />
          ) : (
            <div className="space-y-3">
              {stocktakes.map((st) => {
                const s = st.summary as Summary;
                return (
                  <Card key={st.id} className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <Link
                          href={`/admin/items/stocktake/${st.id}`}
                          className="font-medium hover:underline"
                        >
                          {st.name}
                        </Link>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {st.collection ? `${st.collection.code} · ${st.collection.name}` : "All collections"}
                          {" · "}
                          {st.location ? `${st.location.code} · ${st.location.name}` : "all locations"}
                          {" · "}started {formatDate(st.startedAt)} by {st.startedBy}
                          {st.closedAt && ` · closed ${formatDate(st.closedAt)} by ${st.closedBy}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {st.status === "OPEN" ? (
                          <Badge tone="success">Open · {st._count.scans} scans</Badge>
                        ) : (
                          <Badge tone="muted">Closed</Badge>
                        )}
                      </div>
                    </div>
                    {st.status === "CLOSED" && s && (
                      <p className="mt-2 text-sm" style={{ fontVariantNumeric: "tabular-nums" }}>
                        {s.found ?? 0} found · {s.missing ?? 0} missing · {s.misplaced ?? 0} misplaced ·{" "}
                        {s.unexpected ?? 0} unexpected
                        {s.markedLost ? ` · ${s.markedLost} marked lost` : ""}
                      </p>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {editable && (
          <Card className="h-fit p-5">
            <h2 className="mb-3 font-display text-base font-semibold">Open a stocktake</h2>
            <NewStocktakeForm collections={collections} locations={locations} />
          </Card>
        )}
      </div>
    </div>
  );
}
