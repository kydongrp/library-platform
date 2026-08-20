import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { tally, type StocktakeTallies } from "@/lib/stocktake-core";
import { ScanForm, CloseStocktakeForm, DeleteStocktakeButton, UndoScanButton } from "../widgets";

export const dynamic = "force-dynamic";

const RESULT_TONE = { FOUND: "success", MISPLACED: "accent", UNEXPECTED: "danger" } as const;
const RESULT_LABEL = { FOUND: "Found", MISPLACED: "Misplaced", UNEXPECTED: "Unexpected" } as const;

const MISSING_LIST_MAX = 300;
const SCAN_LOG_MAX = 500;

type FrozenSummary = {
  inScope?: number;
  onLoan?: number;
  found?: number;
  misplaced?: number;
  unexpected?: number;
  missing?: number;
  markedLost?: number;
  missingBarcodes?: string[];
};

type MissingRow = { id: string; barcode: string; status: string; title: string };

export default async function StocktakeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminView("CATALOGUE");
  const editable = canEdit(admin, "CATALOGUE");
  const { id } = await params;

  const st = await prisma.stocktake.findUnique({
    where: { id },
    include: {
      collection: { select: { code: true, name: true } },
      location: { select: { code: true, name: true } },
    },
  });
  if (!st) notFound();

  const scans = await prisma.stocktakeScan.findMany({
    where: { stocktakeId: st.id },
    orderBy: { scannedAt: "desc" },
    take: SCAN_LOG_MAX + 1,
  });
  const scanTotal = await prisma.stocktakeScan.count({ where: { stocktakeId: st.id } });

  let t: StocktakeTallies;
  let missingRows: MissingRow[] = [];
  let missingAvailable = 0;
  let frozenMissingBarcodes: string[] | null = null;

  if (st.status === "CLOSED" && st.summary) {
    // A closed stocktake is the frozen inventory record: render the summary
    // written at close, never a live re-derivation the catalogue has since
    // moved under (a book borrowed a week later must not appear "missing").
    const s = st.summary as FrozenSummary;
    t = {
      expected: Math.max(0, (s.inScope ?? 0) - (s.onLoan ?? 0)),
      onLoan: s.onLoan ?? 0,
      found: s.found ?? 0,
      misplaced: s.misplaced ?? 0,
      unexpected: s.unexpected ?? 0,
      missing: s.missing ?? 0,
      coverage:
        (s.inScope ?? 0) - (s.onLoan ?? 0) <= 0
          ? 100
          : Math.round(
              (((s.inScope ?? 0) - (s.onLoan ?? 0) - (s.missing ?? 0)) /
                ((s.inScope ?? 0) - (s.onLoan ?? 0))) *
                100,
            ),
    };
    frozenMissingBarcodes = s.missingBarcodes ?? [];
  } else {
    // Live derivation for an OPEN stocktake, aggregated in the database — an
    // unscoped stocktake spans every copy in the library, so no query here
    // may materialise the whole copy table. A NULL scope parameter collapses
    // its condition to true.
    const [agg] = await prisma.$queryRaw<
      { total: bigint; onloan: bigint; scannedonshelf: bigint }[]
    >`
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE c.status = 'ON_LOAN') AS onloan,
        count(*) FILTER (WHERE c.status <> 'ON_LOAN' AND s.id IS NOT NULL) AS scannedonshelf
      FROM "Copy" c
      LEFT JOIN "StocktakeScan" s ON s."copyId" = c.id AND s."stocktakeId" = ${st.id}
      WHERE (${st.collectionId}::text IS NULL OR c."collectionId" = ${st.collectionId})
        AND (${st.locationId}::text IS NULL OR c."locationId" = ${st.locationId})`;

    const scanCounts = await prisma.stocktakeScan.groupBy({
      by: ["result"],
      where: { stocktakeId: st.id },
      _count: { _all: true },
    });
    const scanCount = (r: string) => Number(scanCounts.find((s) => s.result === r)?._count._all ?? 0);

    t = tally({
      inScopeTotal: Number(agg?.total ?? 0),
      inScopeOnLoan: Number(agg?.onloan ?? 0),
      found: scanCount("FOUND"),
      misplaced: scanCount("MISPLACED"),
      unexpected: scanCount("UNEXPECTED"),
      scannedOnShelf: Number(agg?.scannedonshelf ?? 0),
    });

    missingRows = await prisma.$queryRaw<MissingRow[]>`
      SELECT c.id, c.barcode, c.status, r.title
      FROM "Copy" c
      JOIN "Resource" r ON r.id = c."resourceId"
      LEFT JOIN "StocktakeScan" s ON s."copyId" = c.id AND s."stocktakeId" = ${st.id}
      WHERE (${st.collectionId}::text IS NULL OR c."collectionId" = ${st.collectionId})
        AND (${st.locationId}::text IS NULL OR c."locationId" = ${st.locationId})
        AND c.status <> 'ON_LOAN' AND s.id IS NULL
      ORDER BY c.barcode
      LIMIT ${MISSING_LIST_MAX + 1}`;
    missingAvailable = missingRows.filter((c) => c.status === "AVAILABLE").length;
  }

  const scopeLabel = [
    st.collection ? `${st.collection.code} · ${st.collection.name}` : "All collections",
    st.location ? `${st.location.code} · ${st.location.name}` : "all locations",
  ].join(", ");

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-semibold">{st.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {scopeLabel} · started {formatDate(st.startedAt)} by {st.startedBy}
            {st.closedAt && ` · closed ${formatDate(st.closedAt)} by ${st.closedBy}`}
            {st.note && ` · ${st.note}`}
          </p>
          <p className="mt-2 text-sm">
            <Link href="/admin/items/stocktake" className="text-primary hover:underline">
              ← All stocktakes
            </Link>
          </p>
        </div>
        {st.status === "OPEN" ? <Badge tone="success">Open</Badge> : <Badge tone="muted">Closed</Badge>}
      </div>

      {/* Tallies */}
      <dl className="mb-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Expected on shelf", t.expected, undefined],
          ["On loan (absent)", t.onLoan, undefined],
          ["Found", t.found, "text-green-700"],
          ["Missing", t.missing, t.missing > 0 ? "text-red-700" : "text-green-700"],
          ["Misplaced", t.misplaced, t.misplaced > 0 ? "text-amber-700" : undefined],
          ["Unexpected", t.unexpected, t.unexpected > 0 ? "text-amber-700" : undefined],
        ].map(([label, value, cls]) => (
          <div key={String(label)} className="rounded-xl border border-border bg-card p-3 shadow-sm">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
            <dd
              className={`mt-0.5 font-display text-xl font-semibold ${cls ?? ""}`}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {Number(value).toLocaleString()}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mb-6 text-xs text-muted-foreground">
        {st.status === "CLOSED"
          ? `Frozen at close. Coverage was ${t.coverage}% of the expected shelf.`
          : `Coverage: ${t.coverage}% of the expected shelf has been scanned.`}
        {st.status === "CLOSED" && (st.summary as FrozenSummary)?.markedLost
          ? ` ${(st.summary as FrozenSummary).markedLost} missing items were marked Lost.`
          : ""}
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          {st.status === "OPEN" && editable && (
            <Card className="p-5">
              <h2 className="mb-3 font-display text-base font-semibold">Scan</h2>
              <ScanForm stocktakeId={st.id} />
            </Card>
          )}

          {st.status === "OPEN" && editable && (
            <Card className="p-5">
              <h2 className="mb-1 font-display text-base font-semibold">Finish</h2>
              <p className="mb-3 text-xs text-muted-foreground">
                Closing freezes the scan list and writes the summary to the inventory record.
              </p>
              <CloseStocktakeForm
                stocktakeId={st.id}
                missing={t.missing}
                missingAvailable={missingAvailable}
              />
              <div className="mt-3 border-t border-border pt-3">
                <DeleteStocktakeButton stocktakeId={st.id} />
              </div>
            </Card>
          )}

          {/* Missing list */}
          <Card className="p-5">
            <h2 className="mb-1 font-display text-base font-semibold">
              Missing ({t.missing.toLocaleString()})
            </h2>
            <p className="mb-3 text-xs text-muted-foreground">
              {st.status === "CLOSED"
                ? "As recorded at close."
                : "In scope, not on loan, not yet scanned."}
            </p>
            {st.status === "CLOSED" && frozenMissingBarcodes ? (
              frozenMissingBarcodes.length === 0 ? (
                <p className="text-sm text-green-700">Every expected item was scanned.</p>
              ) : (
                <ul className="max-h-80 divide-y divide-border overflow-y-auto text-sm">
                  {frozenMissingBarcodes.map((bc) => (
                    <li key={bc} className="py-1.5 font-mono text-xs">{bc}</li>
                  ))}
                  {t.missing > frozenMissingBarcodes.length && (
                    <li className="py-1.5 text-xs text-muted-foreground">
                      …and {(t.missing - frozenMissingBarcodes.length).toLocaleString()} more (the
                      frozen record keeps the first {frozenMissingBarcodes.length}).
                    </li>
                  )}
                </ul>
              )
            ) : missingRows.length === 0 ? (
              <p className="text-sm text-green-700">Every expected item has been scanned.</p>
            ) : (
              <ul className="max-h-80 divide-y divide-border overflow-y-auto text-sm">
                {missingRows.slice(0, MISSING_LIST_MAX).map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="font-mono text-xs">{c.barcode}</span>
                    <span className="min-w-0 flex-1 truncate px-2 text-muted-foreground">{c.title}</span>
                    <Badge tone={c.status === "AVAILABLE" ? "neutral" : "accent"}>
                      {c.status.toLowerCase().replace(/_/g, " ")}
                    </Badge>
                  </li>
                ))}
                {(missingRows.length > MISSING_LIST_MAX || t.missing > MISSING_LIST_MAX) && (
                  <li className="py-1.5 text-xs text-muted-foreground">
                    …and {(t.missing - MISSING_LIST_MAX).toLocaleString()} more.
                  </li>
                )}
              </ul>
            )}
          </Card>
        </div>

        {/* Scan log */}
        <Card className="p-5">
          <h2 className="mb-3 font-display text-base font-semibold">
            Scan log ({scanTotal.toLocaleString()})
          </h2>
          {scans.length === 0 ? (
            <EmptyState title="Nothing scanned yet" description="Scans appear here, newest first." />
          ) : (
            <ul className="max-h-[32rem] divide-y divide-border overflow-y-auto text-sm">
              {scans.slice(0, SCAN_LOG_MAX).map((s) => (
                <li key={s.id} className="py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">{s.barcode}</span>
                    <span className="flex items-center gap-2">
                      <Badge tone={RESULT_TONE[s.result as keyof typeof RESULT_TONE] ?? "neutral"}>
                        {RESULT_LABEL[s.result as keyof typeof RESULT_LABEL] ?? s.result}
                      </Badge>
                      {st.status === "OPEN" && editable && <UndoScanButton scanId={s.id} />}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {formatDate(s.scannedAt)} by {s.scannedBy}
                    {s.detail && ` · ${s.detail}`}
                  </p>
                </li>
              ))}
              {scanTotal > SCAN_LOG_MAX && (
                <li className="py-2 text-xs text-muted-foreground">
                  …{(scanTotal - SCAN_LOG_MAX).toLocaleString()} older scans not shown.
                </li>
              )}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
