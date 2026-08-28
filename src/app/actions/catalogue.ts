"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  listCategories,
  resolveCategory,
  normaliseCategoryName,
  UNCATEGORISED,
} from "@/lib/categories";
import type { ActionState } from "@/lib/types";
import { DIGITAL_TYPES, MATERIAL_DESIGNATIONS, defaultDesignationFor, RESOURCE_LANGUAGES } from "@/lib/constants";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit, diffOf } from "@/lib/audit";
import { emitEventAfter } from "@/lib/webhooks";

// Server actions are directly invocable endpoints, so every mutation must
// re-check CATALOGUE edit rights, not rely on the page hiding buttons.
async function canEditCatalogue(): Promise<boolean> {
  return canEdit(await getCurrentAdmin(), "CATALOGUE");
}

/** Unique-constraint violation (digitalUrl): check-then-write race backstop. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

// Generate the next sequential barcode (LIB-000123).
async function nextBarcodes(count: number): Promise<string[]> {
  const last = await prisma.copy.findFirst({
    orderBy: { barcode: "desc" },
    where: { barcode: { startsWith: "LIB-" } },
  });
  let n = last ? parseInt(last.barcode.replace("LIB-", ""), 10) || 1000 : 1000;
  return Array.from({ length: count }, () => `LIB-${String(++n).padStart(6, "0")}`);
}

async function parseResourceForm(formData: FormData) {
  const type = String(formData.get("type") ?? "BOOK");
  const yearRaw = String(formData.get("publishedYear") ?? "").trim();
  const provider = String(formData.get("provider") ?? "").trim() || null;
  const designationRaw = String(formData.get("materialDesignation") ?? "").toUpperCase();
  const seatsRaw = String(formData.get("licenseSeats") ?? "").trim();
  const languageRaw = String(formData.get("language") ?? "").trim();

  // Category is a managed list now, so the allowed set is a database question.
  // resolveCategory matches case-insensitively and falls back to Uncategorised
  // rather than writing an arbitrary string into what is meant to be a code
  // list.
  const allowed = await listCategories();

  const seats = seatsRaw ? parseInt(seatsRaw, 10) : NaN;

  return {
    title: String(formData.get("title") ?? "").trim(),
    subtitle: String(formData.get("subtitle") ?? "").trim() || null,
    author: String(formData.get("author") ?? "").trim(),
    isbn: String(formData.get("isbn") ?? "").trim() || null,
    type,
    category: resolveCategory(formData.get("category"), allowed),
    publisher: String(formData.get("publisher") ?? "").trim() || null,
    publishedYear: yearRaw ? parseInt(yearRaw, 10) : null,
    // Language of the work itself, which drives the MARC 008 language bytes on
    // export. Anything unrecognised falls back to English, the column default,
    // rather than exporting a language MARC has no code for.
    language: (RESOURCE_LANGUAGES as readonly string[]).includes(languageRaw)
      ? languageRaw
      : "English",
    description: String(formData.get("description") ?? "").trim() || null,
    coverColor: String(formData.get("coverColor") ?? "#0f766e"),
    provider,
    digitalUrl: String(formData.get("digitalUrl") ?? "").trim() || null,
    // Concurrent-user limit for a digital title; null means unlimited. A zero or
    // negative figure is meaningless, so it is treated as unlimited too.
    licenseSeats: Number.isFinite(seats) && seats > 0 ? seats : null,
    // External-provider and digital-format titles have no physical copies.
    digital: DIGITAL_TYPES.has(type) || !!provider,
    // Bib-level designation: staff may override, otherwise it follows the type.
    materialDesignation: (MATERIAL_DESIGNATIONS as readonly string[]).includes(designationRaw)
      ? designationRaw
      : defaultDesignationFor(type),
  };
}

export async function createResource(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditCatalogue()))
    return { ok: false, message: "You don't have permission to edit the catalogue." };
  const data = await parseResourceForm(formData);
  if (!data.title) return { ok: false, message: "Title is required." };
  if (!data.author) return { ok: false, message: "Author is required." };

  if (data.digitalUrl) {
    const clash = await prisma.resource.findFirst({
      where: { digitalUrl: data.digitalUrl },
      select: { title: true },
    });
    if (clash)
      return { ok: false, message: `That access URL already belongs to "${clash.title}".` };
  }

  const copyCount = data.digital
    ? 0
    : Math.max(0, parseInt(String(formData.get("copyCount") ?? "1"), 10) || 0);
  const barcodes = await nextBarcodes(copyCount);

  let resource;
  try {
    resource = await prisma.resource.create({
      data: {
        ...data,
        copies: { create: barcodes.map((barcode) => ({ barcode })) },
      },
    });
  } catch (e) {
    if (isUniqueViolation(e))
      return { ok: false, message: "That access URL already belongs to another title." };
    throw e;
  }

  emitEventAfter("resource.created", { id: resource.id, title: data.title });
  await audit({
    action: "catalogue.create",
    summary: `Created "${data.title}" (${data.type}${copyCount ? `, ${copyCount} copies` : ""})`,
    entity: "Resource",
    entityId: resource.id,
  });
  revalidatePath("/admin/catalogue");
  redirect(`/admin/catalogue/${resource.id}`);
}

export async function updateResource(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditCatalogue()))
    return { ok: false, message: "You don't have permission to edit the catalogue." };
  const id = String(formData.get("id") ?? "");
  const data = await parseResourceForm(formData);
  if (!id) return { ok: false, message: "Missing resource id." };
  if (!data.title || !data.author)
    return { ok: false, message: "Title and author are required." };

  // An external Editor's Pick is identified by its access URL, so stripping it
  // would break the pick's delete semantics and importer dedup.
  const existing = await prisma.resource.findUnique({
    where: { id },
    select: {
      epExternal: true, title: true, subtitle: true, author: true, isbn: true,
      type: true, category: true, publisher: true, publishedYear: true,
      description: true, provider: true, digitalUrl: true,
    },
  });
  if (existing?.epExternal && !data.digitalUrl)
    return {
      ok: false,
      message: "This title is an external Editor's Pick, so it must keep a valid access URL.",
    };

  if (data.digitalUrl) {
    const clash = await prisma.resource.findFirst({
      where: { digitalUrl: data.digitalUrl, NOT: { id } },
      select: { title: true },
    });
    if (clash)
      return { ok: false, message: `That access URL already belongs to "${clash.title}".` };
  }

  try {
    await prisma.resource.update({ where: { id }, data });
  } catch (e) {
    if (isUniqueViolation(e))
      return { ok: false, message: "That access URL already belongs to another title." };
    throw e;
  }
  if (existing) {
    emitEventAfter("resource.updated", { id, title: data.title });
    const { epExternal: _ep, ...beforeFields } = existing;
    const { digital: _d, coverColor: _c, ...afterFields } = data;
    await audit({
      action: "catalogue.update",
      summary: `Edited "${data.title}"`,
      entity: "Resource",
      entityId: id,
      detail: { changed: diffOf(beforeFields, afterFields) },
    });
  }
  revalidatePath(`/admin/catalogue/${id}`);
  revalidatePath("/admin/catalogue");
  return { ok: true, message: "Saved." };
}

export async function deleteResource(formData: FormData): Promise<void> {
  if (!(await canEditCatalogue())) return;
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  // Block deletion when copies are out on loan.
  const active = await prisma.loan.count({
    where: { resourceId: id, status: "ACTIVE" },
  });
  if (active > 0) {
    redirect(`/admin/catalogue/${id}?error=active-loans`);
  }
  await prisma.loan.deleteMany({ where: { resourceId: id } });
  await prisma.reservation.deleteMany({ where: { resourceId: id } });
  await prisma.linkCheck.deleteMany({ where: { resourceId: id } });
  const deleted = await prisma.resource.delete({ where: { id } });
  emitEventAfter("resource.deleted", { id, title: deleted.title });
  await audit({
    action: "catalogue.delete",
    summary: `Deleted "${deleted.title}" and its copies/history`,
    entity: "Resource",
    entityId: id,
    detail: { title: deleted.title, author: deleted.author, provider: deleted.provider },
  });
  revalidatePath("/admin/catalogue");
  redirect("/admin/catalogue");
}

export async function addCopies(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditCatalogue()))
    return { ok: false, message: "You don't have permission to edit the catalogue." };
  const resourceId = String(formData.get("resourceId") ?? "");
  const count = Math.max(1, parseInt(String(formData.get("count") ?? "1"), 10) || 1);
  const location = String(formData.get("location") ?? "Main Shelf");
  if (!resourceId) return { ok: false, message: "Missing resource." };

  const barcodes = await nextBarcodes(count);
  await prisma.copy.createMany({
    data: barcodes.map((barcode) => ({ resourceId, barcode, location })),
  });
  await audit({
    action: "catalogue.addCopies",
    summary: `Added ${count} cop${count === 1 ? "y" : "ies"} (${barcodes[0]}…)`,
    entity: "Resource",
    entityId: resourceId,
  });
  revalidatePath(`/admin/catalogue/${resourceId}`);
  return { ok: true, message: `Added ${count} cop${count === 1 ? "y" : "ies"}.` };
}

export async function setCopyStatus(formData: FormData): Promise<void> {
  if (!(await canEditCatalogue())) return;
  const copyId = String(formData.get("copyId") ?? "");
  const status = String(formData.get("status") ?? "");
  const resourceId = String(formData.get("resourceId") ?? "");
  if (!copyId || !status) return;
  // Don't override a copy that's actively on loan.
  const copy = await prisma.copy.findUnique({ where: { id: copyId } });
  if (copy && copy.status !== "ON_LOAN") {
    await prisma.copy.update({ where: { id: copyId }, data: { status } });
    await audit({
      action: "catalogue.copyStatus",
      summary: `Copy ${copy.barcode}: ${copy.status} → ${status}`,
      entity: "Copy",
      entityId: copyId,
    });
  }
  revalidatePath(`/admin/catalogue/${resourceId}`);
}

export async function deleteCopy(formData: FormData): Promise<void> {
  if (!(await canEditCatalogue())) return;
  const copyId = String(formData.get("copyId") ?? "");
  const resourceId = String(formData.get("resourceId") ?? "");
  if (!copyId) return;
  const copy = await prisma.copy.findUnique({ where: { id: copyId } });
  if (copy && copy.status !== "ON_LOAN") {
    await prisma.copy.delete({ where: { id: copyId } });
    await audit({
      action: "catalogue.copyDelete",
      summary: `Deleted copy ${copy.barcode}`,
      entity: "Copy",
      entityId: copyId,
    });
  }
  revalidatePath(`/admin/catalogue/${resourceId}`);
}

/* ---------- Category code list ---------- */

/**
 * Add an Area of Interest from the catalogue form.
 *
 * Added here rather than on a settings page because the moment you need a new
 * category is the moment you are cataloguing something that does not fit the
 * existing ones, and making staff leave the record to go and create one is how
 * you end up with everything filed under Technology.
 */
export async function createResourceCategory(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditCatalogue()))
    return { ok: false, message: "You don't have permission to manage categories." };

  const name = normaliseCategoryName(formData.get("name"));
  if (!name) return { ok: false, message: "Give the category a name." };

  // Case-insensitive duplicate check before insert: the unique index is
  // case-SENSITIVE, so "science" and "Science" would both be accepted and the
  // list would grow two entries meaning the same thing.
  const existing = await listCategories();
  const clash = existing.find((c) => c.toLowerCase() === name.toLowerCase());
  if (clash) {
    return { ok: false, message: `"${clash}" already exists.` };
  }

  try {
    // Sorted after everything currently listed.
    const last = await prisma.resourceCategory.findFirst({ orderBy: { sortOrder: "desc" } });
    await prisma.resourceCategory.create({
      data: { name, sortOrder: (last?.sortOrder ?? 0) + 1 },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, message: `"${name}" already exists.` };
    throw e;
  }

  await audit({
    action: "catalogue.category.create",
    summary: `Added category "${name}"`,
    entity: "ResourceCategory",
  });
  revalidatePath("/admin/catalogue");
  return { ok: true, message: `"${name}" added. Pick it from the Category list.` };
}

/**
 * Remove an Area of Interest from the list.
 *
 * Resources already filed under it keep their value, exactly as the member code
 * lists behave, and listCategories still offers any value that is in use so
 * those records round-trip through the edit form. So this hides a category from
 * new records rather than reclassifying old ones.
 */
export async function deleteResourceCategory(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditCatalogue()))
    return { ok: false, message: "You don't have permission to manage categories." };

  const id = String(formData.get("id") ?? "");
  const row = await prisma.resourceCategory.findUnique({ where: { id } });
  if (!row) return { ok: false, message: "That category no longer exists." };
  if (row.name === UNCATEGORISED) {
    return {
      ok: false,
      message: `"${UNCATEGORISED}" cannot be removed: it is where imported records land.`,
    };
  }

  const inUse = await prisma.resource.count({ where: { category: row.name } });
  await prisma.resourceCategory.delete({ where: { id } });

  await audit({
    action: "catalogue.category.delete",
    summary: `Removed category "${row.name}" from the list`,
    entity: "ResourceCategory",
    entityId: id,
    detail: { inUse },
  });
  revalidatePath("/admin/catalogue");
  return {
    ok: true,
    message:
      inUse > 0
        ? `"${row.name}" removed from the list. ${inUse} record${inUse === 1 ? "" : "s"} still filed under it keep it.`
        : `"${row.name}" removed.`,
  };
}
