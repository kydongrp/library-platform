"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit } from "@/lib/audit";
import { COPY_STATUSES } from "@/lib/constants";

// Item-level management is catalogue work (items belong to bib records).
async function requireItemsEditor(): Promise<{ name: string } | null> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "CATALOGUE")) return null;
  return { name: admin!.name };
}

const NO_PERMISSION = {
  ok: false as const,
  message: "You don't have permission to manage items.",
};

const clip = (v: FormDataEntryValue | null, n: number) => String(v ?? "").trim().slice(0, n);
const MAX_BATCH = 500;

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

/** Codes are uppercase, no spaces: they appear on spine labels and exports. */
function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "_").slice(0, 24);
}

/* ---------- Code lists ---------- */

type ListKind = "collection" | "location" | "itemType";

async function createCodeRow(kind: ListKind, formData: FormData): Promise<ActionState> {
  const admin = await requireItemsEditor();
  if (!admin) return NO_PERMISSION;

  const code = normaliseCode(clip(formData.get("code"), 24));
  const name = clip(formData.get("name"), 80);
  if (!code) return { ok: false, message: "A short code is required (e.g. REF)." };
  if (!name) return { ok: false, message: "A name is required." };

  try {
    if (kind === "collection") {
      const limitRaw = clip(formData.get("loanLimitOverride"), 6);
      const limit = limitRaw ? parseInt(limitRaw, 10) : null;
      if (limitRaw && (!Number.isInteger(limit) || limit! < 0 || limit! > 100))
        return { ok: false, message: "Loan limit override must be a whole number." };
      await prisma.itemCollection.create({
        data: { code, name, loanLimitOverride: limit, notes: clip(formData.get("notes"), 200) || null },
      });
    } else if (kind === "location") {
      await prisma.itemLocation.create({
        data: { code, name, notes: clip(formData.get("notes"), 200) || null },
      });
    } else {
      await prisma.itemType.create({
        data: {
          code,
          name,
          loanable: formData.get("loanable") === "on",
          // Row 56: blank means the usual day-based policy. Clamped to a
          // sane range so a typo cannot create a 100,000-hour loan.
          loanHours: (() => {
            const raw = clip(formData.get("loanHours"), 6);
            if (!raw) return null;
            const n = parseInt(raw, 10);
            return Number.isFinite(n) && n > 0 ? Math.min(n, 720) : null;
          })(),
        },
      });
    }
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, message: `Code "${code}" already exists.` };
    throw e;
  }

  await audit({
    action: `items.${kind}.create`,
    summary: `Added item ${kind === "itemType" ? "type" : kind} ${code}: ${name}`,
    entity: "ItemCollection",
  });
  revalidatePath("/admin/items");
  return { ok: true, message: `${code} added.` };
}

// Each must be an exported `async function`: Next rejects arrow consts as
// server actions, and TypeScript won't flag it.
export async function createCollection(_p: ActionState, f: FormData): Promise<ActionState> {
  return createCodeRow("collection", f);
}
export async function createLocation(_p: ActionState, f: FormData): Promise<ActionState> {
  return createCodeRow("location", f);
}
export async function createItemType(_p: ActionState, f: FormData): Promise<ActionState> {
  return createCodeRow("itemType", f);
}

export async function deleteCodeRow(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireItemsEditor();
  if (!admin) return NO_PERMISSION;

  const kind = clip(formData.get("kind"), 20) as ListKind;
  const id = clip(formData.get("id"), 40);

  // Copies keep working when a code is removed (the FK nulls out), but a
  // policy row keyed on an item type would vanish with it; say so first.
  if (kind === "itemType") {
    const inUse = await prisma.loanPolicy.count({ where: { itemTypeId: id } });
    if (inUse > 0)
      return {
        ok: false,
        message: `${inUse} loan polic${inUse === 1 ? "y" : "ies"} use this item type. Delete those rows first.`,
      };
  }

  // An OPEN stocktake scoped to this code must block the delete: nulling the
  // FK would silently widen its scope to the whole library, and closing it
  // with "mark missing as lost" could then flip every unscanned copy to LOST.
  if (kind === "collection" || kind === "location") {
    const scopeField = kind === "collection" ? "collectionId" : "locationId";
    const openCount = await prisma.stocktake.count({
      where: { status: "OPEN", [scopeField]: id },
    });
    if (openCount > 0)
      return {
        ok: false,
        message: `An open stocktake is scoped to this ${kind}. Close or discard it first.`,
      };
  }

  const table =
    kind === "collection" ? prisma.itemCollection
    : kind === "location" ? prisma.itemLocation
    : kind === "itemType" ? prisma.itemType
    : null;
  if (!table) return { ok: false, message: "Unknown list." };

  const row = await (table as { findUnique: (a: unknown) => Promise<{ code: string } | null> })
    .findUnique({ where: { id } });
  if (!row) return { ok: false, message: "That entry no longer exists." };
  await (table as { delete: (a: unknown) => Promise<unknown> }).delete({ where: { id } });

  await audit({
    action: `items.${kind}.delete`,
    summary: `Deleted item ${kind === "itemType" ? "type" : kind} ${row.code}`,
    entity: "ItemCollection",
    entityId: id,
  });
  revalidatePath("/admin/items");
  return { ok: true, message: `${row.code} deleted. Items that used it keep their other details.` };
}

/* ---------- Batch property change (Vibrant: Change Item Properties) ---------- */

export async function changeItemProperties(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireItemsEditor();
  if (!admin) return NO_PERMISSION;

  const ids = String(formData.get("copyIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_BATCH);
  if (ids.length === 0) return { ok: false, message: "Select at least one item." };

  // Blank means "leave alone"; "__clear__" means "unset".
  const val = (name: string) => {
    const v = clip(formData.get(name), 40);
    return v === "" ? undefined : v === "__clear__" ? null : v;
  };
  const collectionId = val("collectionId");
  const locationId = val("locationId");
  const itemTypeId = val("itemTypeId");
  const statusRaw = clip(formData.get("status"), 20);

  const data: Record<string, unknown> = {};
  if (collectionId !== undefined) data.collectionId = collectionId;
  if (locationId !== undefined) data.locationId = locationId;
  if (itemTypeId !== undefined) data.itemTypeId = itemTypeId;
  if (statusRaw) {
    if (!(COPY_STATUSES as readonly string[]).includes(statusRaw))
      return { ok: false, message: "Unknown status." };
    data.status = statusRaw;
  }
  if (Object.keys(data).length === 0)
    return { ok: false, message: "Choose at least one property to change." };

  // Never yank an item out from under an active loan.
  const onLoan = await prisma.copy.count({ where: { id: { in: ids }, status: "ON_LOAN" } });
  if (data.status && onLoan > 0)
    return {
      ok: false,
      message: `${onLoan} of the selected items ${onLoan === 1 ? "is" : "are"} on loan. Their status can't be changed until they're returned.`,
    };

  const r = await prisma.copy.updateMany({ where: { id: { in: ids } }, data });
  await audit({
    action: "items.batchChange",
    summary: `Changed properties on ${r.count} item${r.count === 1 ? "" : "s"} (${Object.keys(data).join(", ")})`,
    entity: "Copy",
    detail: { count: r.count, changed: data },
  });
  revalidatePath("/admin/items");
  revalidatePath("/admin/catalogue");
  return { ok: true, message: `Updated ${r.count} item${r.count === 1 ? "" : "s"}.` };
}

/* ---------- Weeding (Vibrant: Weed Item / Batch Items Deletion + Weed Log) ---------- */

export async function weedItems(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireItemsEditor();
  if (!admin) return NO_PERMISSION;

  const ids = String(formData.get("copyIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_BATCH);
  if (ids.length === 0) return { ok: false, message: "Select at least one item to weed." };
  const reason = clip(formData.get("reason"), 200);
  if (!reason) return { ok: false, message: "A reason is required: it goes on the weeding log." };

  const copies = await prisma.copy.findMany({
    where: { id: { in: ids } },
    include: {
      resource: { select: { title: true } },
      collection: { select: { code: true } },
      itemLocation: { select: { code: true } },
    },
  });
  const onLoan = copies.filter((c) => c.status === "ON_LOAN");
  if (onLoan.length > 0)
    return {
      ok: false,
      message: `${onLoan.length} selected item${onLoan.length === 1 ? " is" : "s are"} on loan. Return ${onLoan.length === 1 ? "it" : "them"} first.`,
    };

  // Log before deleting: the log is the only record that survives.
  await prisma.itemWeedLog.createMany({
    data: copies.map((c) => ({
      barcode: c.barcode,
      title: c.resource.title,
      reason,
      collection: c.collection?.code ?? null,
      location: c.itemLocation?.code ?? c.location,
      weededBy: admin.name,
    })),
  });
  // Loans reference copies, so detach history rather than cascade-deleting it.
  await prisma.loan.updateMany({ where: { copyId: { in: ids } }, data: { copyId: null } });
  const r = await prisma.copy.deleteMany({ where: { id: { in: ids } } });

  await audit({
    action: "items.weed",
    summary: `Weeded ${r.count} item${r.count === 1 ? "" : "s"}: ${reason}`,
    entity: "Copy",
    detail: { count: r.count, reason, barcodes: copies.map((c) => c.barcode).slice(0, 50) },
  });
  revalidatePath("/admin/items");
  revalidatePath("/admin/catalogue");
  return {
    ok: true,
    message: `Weeded ${r.count} item${r.count === 1 ? "" : "s"}. Loan history is kept; the weeding log records what went.`,
  };
}

/* ---------- Bulk items import (comparison row 36) ---------- */

const IMPORT_MAX_BYTES = 3_500_000;

/**
 * Import item records from XML (the Vibrant exchange format), CSV or JSON.
 * Each row carries a barcode plus an ISBN, title or record id to say which
 * bib the copy belongs to; unknown codes and unmatched bibs are reported per
 * row, never guessed.
 */
export async function importItems(_p: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireItemsEditor();
  if (!admin) return NO_PERMISSION;

  const { parseItemRows } = await import("@/lib/item-import");

  let text = "";
  let source = "pasted rows";
  const file = formData.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > IMPORT_MAX_BYTES)
      return { ok: false, message: "That file is over 3.5MB. Split it and import in parts." };
    text = await file.text();
    source = file.name.slice(0, 120) || "upload";
  } else {
    text = String(formData.get("pasted") ?? "");
    if (text.length > IMPORT_MAX_BYTES)
      return { ok: false, message: "Pasted content is too large. Import in parts." };
  }
  if (!text.trim())
    return {
      ok: false,
      message: "Upload an XML/CSV/JSON file or paste rows (each needs a barcode plus an ISBN, title or record id).",
    };

  const parsed = parseItemRows(text, source);
  if (parsed.rows.length === 0) {
    const why =
      parsed.warnings[0] ??
      parsed.skipped.slice(0, 3).map((s) => `row ${s.line}: ${s.reason}`).join("; ");
    return { ok: false, message: why || "No importable rows found." };
  }

  // Resolve the code lists once.
  const [collections, locations, itemTypes] = await Promise.all([
    prisma.itemCollection.findMany({ select: { id: true, code: true } }),
    prisma.itemLocation.findMany({ select: { id: true, code: true } }),
    prisma.itemType.findMany({ select: { id: true, code: true } }),
  ]);
  const collByCode = new Map(collections.map((c) => [c.code, c.id]));
  const locByCode = new Map(locations.map((c) => [c.code, c.id]));
  const typeByCode = new Map(itemTypes.map((c) => [c.code, c.id]));

  // Resolve bibs: by record id, then ISBN (normalised), then exact title.
  const { normaliseIsbn } = await import("@/lib/item-import");
  const ids = [...new Set(parsed.rows.map((r) => r.resourceId).filter((v): v is string => !!v))];
  const isbns = [...new Set(parsed.rows.map((r) => r.isbn).filter((v): v is string => !!v))];
  const titles = [...new Set(parsed.rows.map((r) => r.title).filter((v): v is string => !!v))];

  const [byId, withIsbn, byTitle] = await Promise.all([
    ids.length
      ? prisma.resource.findMany({ where: { id: { in: ids } }, select: { id: true } })
      : Promise.resolve([]),
    // Normalise the catalogue side in the database so this stays a single
    // bounded query at any catalogue size, instead of loading every ISBN.
    isbns.length
      ? prisma.$queryRaw<{ id: string; isbn: string }[]>`
          SELECT id, upper(regexp_replace(isbn, '[^0-9Xx]', '', 'g')) AS isbn
          FROM "Resource"
          WHERE isbn IS NOT NULL
            AND upper(regexp_replace(isbn, '[^0-9Xx]', '', 'g')) = ANY(${isbns})`
      : Promise.resolve([]),
    titles.length
      ? prisma.resource.findMany({
          where: { title: { in: titles, mode: "insensitive" } },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
  ]);
  const idSet = new Set(byId.map((r) => r.id));
  // Collision-aware maps: a key shared by several records must NOT attach the
  // copy to whichever happened to come back last (e.g. two editions with the
  // same title). Ambiguity is reported per row instead.
  const AMBIGUOUS = " ambiguous";
  const isbnMap = new Map<string, string>();
  for (const r of withIsbn) {
    if (!r.isbn) continue;
    const k = normaliseIsbn(r.isbn);
    isbnMap.set(k, isbnMap.has(k) && isbnMap.get(k) !== r.id ? AMBIGUOUS : r.id);
  }
  const titleMap = new Map<string, string>();
  for (const r of byTitle) {
    const k = r.title.toLowerCase();
    titleMap.set(k, titleMap.has(k) && titleMap.get(k) !== r.id ? AMBIGUOUS : r.id);
  }

  const skipped = [...parsed.skipped];
  const data: {
    barcode: string;
    resourceId: string;
    status: string;
    collectionId: string | null;
    locationId: string | null;
    itemTypeId: string | null;
  }[] = [];

  for (const row of parsed.rows) {
    const resourceId =
      (row.resourceId && idSet.has(row.resourceId) && row.resourceId) ||
      (row.isbn && isbnMap.get(row.isbn)) ||
      (row.title && titleMap.get(row.title.toLowerCase())) ||
      null;
    if (!resourceId) {
      skipped.push({ line: row.line, reason: `${row.barcode}: no catalogue record matches` });
      continue;
    }
    if (resourceId === AMBIGUOUS) {
      skipped.push({
        line: row.line,
        reason: `${row.barcode}: several catalogue records share this ${row.isbn && isbnMap.get(row.isbn) === AMBIGUOUS ? "ISBN" : "title"}; import with the record id instead`,
      });
      continue;
    }
    // Unknown codes are rejected, not invented: the code lists are curated.
    const badCode =
      (row.collectionCode && !collByCode.has(row.collectionCode) && `collection ${row.collectionCode}`) ||
      (row.locationCode && !locByCode.has(row.locationCode) && `location ${row.locationCode}`) ||
      (row.itemTypeCode && !typeByCode.has(row.itemTypeCode) && `item type ${row.itemTypeCode}`);
    if (badCode) {
      skipped.push({ line: row.line, reason: `${row.barcode}: unknown ${badCode}` });
      continue;
    }
    data.push({
      barcode: row.barcode,
      resourceId,
      status: row.status,
      collectionId: row.collectionCode ? collByCode.get(row.collectionCode)! : null,
      locationId: row.locationCode ? locByCode.get(row.locationCode)! : null,
      itemTypeId: row.itemTypeCode ? typeByCode.get(row.itemTypeCode)! : null,
    });
  }

  const result = data.length
    ? await prisma.copy.createMany({ data, skipDuplicates: true })
    : { count: 0 };
  const dupes = data.length - result.count;

  await audit({
    action: "items.import",
    summary: `Bulk items import from ${source}: ${result.count} imported, ${dupes} barcodes already existed, ${skipped.length} skipped`,
    entity: "Copy",
    detail: {
      source,
      imported: result.count,
      duplicates: dupes,
      skipped: skipped.slice(0, 20),
      warnings: parsed.warnings,
    },
  });
  revalidatePath("/admin/items");
  revalidatePath("/admin/catalogue");

  const parts = [`${result.count} imported`];
  if (dupes > 0) parts.push(`${dupes} barcodes already existed`);
  if (skipped.length > 0) {
    const sample = skipped.slice(0, 3).map((s) => `row ${s.line}: ${s.reason}`).join("; ");
    parts.push(`${skipped.length} skipped (${sample}${skipped.length > 3 ? "…" : ""})`);
  }
  return {
    ok: result.count > 0 || skipped.length === 0,
    message: `${parts.join(" · ")}.${parsed.warnings.length ? ` ${parsed.warnings.join(" ")}` : ""}`,
  };
}
