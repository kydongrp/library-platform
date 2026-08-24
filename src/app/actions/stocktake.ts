"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit } from "@/lib/audit";
import { classifyScan, normaliseBarcode, type ScanScope } from "@/lib/stocktake-core";

// Stocktake is item-level catalogue work, same permission as the Items module.
async function requireStocktaker(): Promise<{ name: string } | null> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "CATALOGUE")) return null;
  return { name: admin!.name };
}

const NO_PERMISSION = {
  ok: false as const,
  message: "You don't have permission to run stocktakes.",
};

const clip = (v: FormDataEntryValue | null, n: number) => String(v ?? "").trim().slice(0, n);

/* ---------- Lifecycle ---------- */

export async function createStocktake(_p: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireStocktaker();
  if (!admin) return NO_PERMISSION;

  const name = clip(formData.get("name"), 120);
  if (!name) return { ok: false, message: "Give the stocktake a name (e.g. FY2026 Reference Room)." };
  const collectionId = clip(formData.get("collectionId"), 40) || null;
  const locationId = clip(formData.get("locationId"), 40) || null;
  const note = clip(formData.get("note"), 500) || null;

  // The submitted scope ids must exist: a stale form (the code was deleted
  // while it sat open) or a tampered id would otherwise crash on the FK.
  if (collectionId) {
    const c = await prisma.itemCollection.findUnique({ where: { id: collectionId }, select: { id: true } });
    if (!c) return { ok: false, message: "That collection no longer exists. Reload and pick again." };
  }
  if (locationId) {
    const l = await prisma.itemLocation.findUnique({ where: { id: locationId }, select: { id: true } });
    if (!l) return { ok: false, message: "That location no longer exists. Reload and pick again." };
  }

  // One open stocktake per scope slice keeps scans unambiguous. (findFirst
  // then create can race two simultaneous submits into two open stocktakes.
  // Each keeps its own scan list, so no data is harmed and staff can discard one.)
  const open = await prisma.stocktake.findFirst({
    where: { status: "OPEN", collectionId, locationId },
    select: { name: true },
  });
  if (open) {
    return { ok: false, message: `"${open.name}" is already open for this scope. Close it first.` };
  }

  const st = await prisma.stocktake.create({
    data: { name, collectionId, locationId, note, startedBy: admin.name },
    include: { collection: true, location: true },
  });
  await audit({
    action: "stocktake.open",
    summary: `Opened stocktake "${name}"${st.collection ? ` · ${st.collection.code}` : ""}${st.location ? ` · ${st.location.code}` : ""}`,
    entity: "Stocktake",
    entityId: st.id,
  });
  revalidatePath("/admin/items/stocktake");
  redirect(`/admin/items/stocktake/${st.id}`);
}

/* ---------- Scanning ---------- */

export async function recordScan(_p: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireStocktaker();
  if (!admin) return NO_PERMISSION;

  const stocktakeId = clip(formData.get("stocktakeId"), 40);
  const barcode = normaliseBarcode(clip(formData.get("barcode"), 64));
  if (!barcode) return { ok: false, message: "Scan or type a barcode." };

  const st = await prisma.stocktake.findUnique({
    where: { id: stocktakeId },
    select: { id: true, status: true, collectionId: true, locationId: true },
  });
  if (!st) return { ok: false, message: "Stocktake not found." };
  if (st.status !== "OPEN") return { ok: false, message: "This stocktake is closed. Scans are frozen." };

  const scope: ScanScope = { collectionId: st.collectionId, locationId: st.locationId };
  // Case-insensitive lookup: imports store barcodes uppercase, but copies
  // catalogued by hand may carry lowercase barcodes.
  const copy = await prisma.copy.findFirst({
    where: { barcode: { equals: barcode, mode: "insensitive" } },
    select: {
      id: true,
      status: true,
      collectionId: true,
      locationId: true,
      collection: { select: { code: true, name: true } },
      itemLocation: { select: { code: true, name: true } },
      resource: { select: { title: true } },
    },
  });

  const verdict = classifyScan(
    copy
      ? {
          id: copy.id,
          status: copy.status,
          collectionId: copy.collectionId,
          locationId: copy.locationId,
          collectionLabel: copy.collection ? `${copy.collection.code} · ${copy.collection.name}` : null,
          locationLabel: copy.itemLocation ? `${copy.itemLocation.code} · ${copy.itemLocation.name}` : null,
        }
      : null,
    scope,
  );

  let scanId: string;
  try {
    const scan = await prisma.stocktakeScan.create({
      data: {
        stocktakeId: st.id,
        barcode,
        copyId: copy?.id ?? null,
        result: verdict.result,
        detail: verdict.detail,
        scannedBy: admin.name,
      },
    });
    scanId = scan.id;
  } catch (e) {
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") {
      return { ok: false, message: `${barcode} was already scanned in this stocktake.` };
    }
    throw e;
  }

  // The close action claims the stocktake (OPEN → CLOSED) before it reads the
  // scan list. If that claim landed between our status check and our insert,
  // this scan is invisible to the frozen summary, so take it back out.
  const after = await prisma.stocktake.findUnique({ where: { id: st.id }, select: { status: true } });
  if (after?.status !== "OPEN") {
    await prisma.stocktakeScan.delete({ where: { id: scanId } }).catch(() => {});
    return { ok: false, message: "This stocktake was closed while you were scanning. The scan was not recorded." };
  }

  revalidatePath(`/admin/items/stocktake/${st.id}`);
  const title = copy?.resource.title ? `, ${copy.resource.title.slice(0, 60)}` : "";
  const label =
    verdict.result === "FOUND" ? "Found" : verdict.result === "MISPLACED" ? "MISPLACED" : "UNEXPECTED";
  return {
    ok: verdict.result === "FOUND",
    message: `${label}: ${barcode}${title}${verdict.detail ? ` (${verdict.detail})` : ""}`,
  };
}

export async function undoScan(_p: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireStocktaker();
  if (!admin) return NO_PERMISSION;
  const id = clip(formData.get("scanId"), 40);
  const scan = await prisma.stocktakeScan.findUnique({ where: { id } });
  if (!scan) return { ok: false, message: "Scan not found." };

  const st = await prisma.stocktake.findUnique({
    where: { id: scan.stocktakeId },
    select: { status: true },
  });
  if (st?.status !== "OPEN") return { ok: false, message: "This stocktake is closed. Scans are frozen." };

  await prisma.stocktakeScan.delete({ where: { id } });

  // Same race as recordScan, mirrored: if the close claimed the stocktake
  // between our check and our delete, its frozen summary counted this scan,
  // so put it back to keep the record internally consistent.
  const after = await prisma.stocktake.findUnique({
    where: { id: scan.stocktakeId },
    select: { status: true },
  });
  if (after?.status !== "OPEN") {
    await prisma.stocktakeScan
      .create({
        data: {
          stocktakeId: scan.stocktakeId,
          barcode: scan.barcode,
          copyId: scan.copyId,
          result: scan.result,
          detail: scan.detail,
          scannedBy: scan.scannedBy,
          scannedAt: scan.scannedAt,
        },
      })
      .catch(() => {});
    return { ok: false, message: "This stocktake was closed while you were working. The scan stays." };
  }

  revalidatePath(`/admin/items/stocktake/${scan.stocktakeId}`);
  return { ok: true, message: `Removed the scan of ${scan.barcode}.` };
}

/* ---------- Closing ---------- */

export async function closeStocktake(_p: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireStocktaker();
  if (!admin) return NO_PERMISSION;

  const id = clip(formData.get("stocktakeId"), 40);
  const markLost = formData.get("markLost") === "on";

  const st = await prisma.stocktake.findUnique({
    where: { id },
    include: { collection: true, location: true },
  });
  if (!st) return { ok: false, message: "Stocktake not found." };

  // Claim first: a status-conditioned write is the lock. A concurrent close
  // loses this race and stops here instead of overwriting the frozen record;
  // scans that land after this claim delete themselves (see recordScan).
  const claim = await prisma.stocktake.updateMany({
    where: { id, status: "OPEN" },
    data: { status: "CLOSED", closedBy: admin.name, closedAt: new Date() },
  });
  if (claim.count === 0) return { ok: false, message: "Already closed." };

  // Aggregate in the database. An unscoped stocktake spans every copy in the
  // library, so nothing here may load the whole copy table into memory. A
  // NULL scope parameter collapses its condition to true.
  const [scopeAgg, scanAgg, missingSample] = await Promise.all([
    prisma.$queryRaw<{ total: bigint; onloan: bigint; scannedonshelf: bigint; missing: bigint }[]>`
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE c.status = 'ON_LOAN') AS onloan,
        count(*) FILTER (WHERE c.status <> 'ON_LOAN' AND s.id IS NOT NULL) AS scannedonshelf,
        count(*) FILTER (WHERE c.status <> 'ON_LOAN' AND s.id IS NULL) AS missing
      FROM "Copy" c
      LEFT JOIN "StocktakeScan" s ON s."copyId" = c.id AND s."stocktakeId" = ${id}
      WHERE (${st.collectionId}::text IS NULL OR c."collectionId" = ${st.collectionId})
        AND (${st.locationId}::text IS NULL OR c."locationId" = ${st.locationId})`,
    prisma.stocktakeScan.groupBy({
      by: ["result"],
      where: { stocktakeId: id },
      _count: { _all: true },
    }),
    // A bounded sample of missing barcodes for the frozen record.
    prisma.$queryRaw<{ barcode: string }[]>`
      SELECT c.barcode
      FROM "Copy" c
      LEFT JOIN "StocktakeScan" s ON s."copyId" = c.id AND s."stocktakeId" = ${id}
      WHERE (${st.collectionId}::text IS NULL OR c."collectionId" = ${st.collectionId})
        AND (${st.locationId}::text IS NULL OR c."locationId" = ${st.locationId})
        AND c.status <> 'ON_LOAN' AND s.id IS NULL
      ORDER BY c.barcode
      LIMIT 500`,
  ]);

  const agg = scopeAgg[0];
  const scanCount = (r: string) => Number(scanAgg.find((s) => s.result === r)?._count._all ?? 0);
  const counts = {
    inScope: Number(agg?.total ?? 0),
    onLoan: Number(agg?.onloan ?? 0),
    found: scanCount("FOUND"),
    misplaced: scanCount("MISPLACED"),
    unexpected: scanCount("UNEXPECTED"),
    missing: Number(agg?.missing ?? 0),
    markedLost: 0,
  };

  if (markLost && counts.missing > 0) {
    // Flip in the database with the same NOT-EXISTS shape: no id list in
    // memory, and only shelve-able (AVAILABLE) copies change status.
    const flipped = await prisma.$executeRaw`
      UPDATE "Copy" c
      SET status = 'LOST'
      WHERE (${st.collectionId}::text IS NULL OR c."collectionId" = ${st.collectionId})
        AND (${st.locationId}::text IS NULL OR c."locationId" = ${st.locationId})
        AND c.status = 'AVAILABLE'
        AND NOT EXISTS (
          SELECT 1 FROM "StocktakeScan" s
          WHERE s."stocktakeId" = ${id} AND s."copyId" = c.id
        )`;
    counts.markedLost = Number(flipped);
  }

  await prisma.stocktake.update({
    where: { id },
    data: {
      summary: {
        ...counts,
        missingBarcodes: missingSample.map((r) => r.barcode),
      },
    },
  });
  await audit({
    action: "stocktake.close",
    summary: `Closed stocktake "${st.name}": ${counts.found} found, ${counts.missing} missing, ${counts.misplaced} misplaced, ${counts.unexpected} unexpected${counts.markedLost ? `, ${counts.markedLost} marked lost` : ""}`,
    entity: "Stocktake",
    entityId: st.id,
    detail: counts,
  });
  revalidatePath(`/admin/items/stocktake/${st.id}`);
  revalidatePath("/admin/items/stocktake");
  revalidatePath("/admin/items");
  return {
    ok: true,
    message: `Closed. ${counts.found} found · ${counts.missing} missing${counts.markedLost ? ` (${counts.markedLost} marked lost)` : ""} · ${counts.misplaced} misplaced · ${counts.unexpected} unexpected.`,
  };
}

export async function deleteStocktake(_p: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireStocktaker();
  if (!admin) return NO_PERMISSION;
  const id = clip(formData.get("stocktakeId"), 40);
  const st = await prisma.stocktake.findUnique({
    where: { id },
    select: { name: true, status: true, _count: { select: { scans: true } } },
  });
  if (!st) return { ok: false, message: "Stocktake not found." };
  // Status-conditioned delete: a stocktake that just closed is the inventory
  // record and must survive a racing discard click.
  const res = await prisma.stocktake.deleteMany({ where: { id, status: "OPEN" } });
  if (res.count === 0)
    return { ok: false, message: "Closed stocktakes are kept as the inventory record." };
  await audit({
    action: "stocktake.delete",
    summary: `Deleted open stocktake "${st.name}" (${st._count.scans} scans discarded)`,
    entity: "Stocktake",
  });
  revalidatePath("/admin/items/stocktake");
  redirect("/admin/items/stocktake");
}
