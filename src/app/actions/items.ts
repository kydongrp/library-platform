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

/** Codes are uppercase, no spaces — they appear on spine labels and exports. */
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
        data: { code, name, loanable: formData.get("loanable") === "on" },
      });
    }
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, message: `Code "${code}" already exists.` };
    throw e;
  }

  await audit({
    action: `items.${kind}.create`,
    summary: `Added item ${kind === "itemType" ? "type" : kind} ${code} — ${name}`,
    entity: "ItemCollection",
  });
  revalidatePath("/admin/items");
  return { ok: true, message: `${code} added.` };
}

// Each must be an exported `async function` — Next rejects arrow consts as
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
  // policy row keyed on an item type would vanish with it — say so first.
  if (kind === "itemType") {
    const inUse = await prisma.loanPolicy.count({ where: { itemTypeId: id } });
    if (inUse > 0)
      return {
        ok: false,
        message: `${inUse} loan polic${inUse === 1 ? "y" : "ies"} use this item type — delete those rows first.`,
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
  return { ok: true, message: `${row.code} deleted — items that used it keep their other details.` };
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
      message: `${onLoan} of the selected items ${onLoan === 1 ? "is" : "are"} on loan — their status can't be changed until they're returned.`,
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
  if (!reason) return { ok: false, message: "A reason is required — it goes on the weeding log." };

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
      message: `${onLoan.length} selected item${onLoan.length === 1 ? " is" : "s are"} on loan — return ${onLoan.length === 1 ? "it" : "them"} first.`,
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
    summary: `Weeded ${r.count} item${r.count === 1 ? "" : "s"} — ${reason}`,
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
