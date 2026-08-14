"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { DIGITAL_TYPES } from "@/lib/constants";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit, diffOf } from "@/lib/audit";

// Server actions are directly invocable endpoints — every mutation must
// re-check CATALOGUE edit rights, not rely on the page hiding buttons.
async function canEditCatalogue(): Promise<boolean> {
  return canEdit(await getCurrentAdmin(), "CATALOGUE");
}

/** Unique-constraint violation (digitalUrl) — check-then-write race backstop. */
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

function parseResourceForm(formData: FormData) {
  const type = String(formData.get("type") ?? "BOOK");
  const yearRaw = String(formData.get("publishedYear") ?? "").trim();
  const provider = String(formData.get("provider") ?? "").trim() || null;
  return {
    title: String(formData.get("title") ?? "").trim(),
    subtitle: String(formData.get("subtitle") ?? "").trim() || null,
    author: String(formData.get("author") ?? "").trim(),
    isbn: String(formData.get("isbn") ?? "").trim() || null,
    type,
    category: String(formData.get("category") ?? "Technology"),
    publisher: String(formData.get("publisher") ?? "").trim() || null,
    publishedYear: yearRaw ? parseInt(yearRaw, 10) : null,
    description: String(formData.get("description") ?? "").trim() || null,
    coverColor: String(formData.get("coverColor") ?? "#0f766e"),
    provider,
    digitalUrl: String(formData.get("digitalUrl") ?? "").trim() || null,
    // External-provider and digital-format titles have no physical copies.
    digital: DIGITAL_TYPES.has(type) || !!provider,
  };
}

export async function createResource(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditCatalogue()))
    return { ok: false, message: "You don't have permission to edit the catalogue." };
  const data = parseResourceForm(formData);
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
  const data = parseResourceForm(formData);
  if (!id) return { ok: false, message: "Missing resource id." };
  if (!data.title || !data.author)
    return { ok: false, message: "Title and author are required." };

  // An external Editor's Pick is identified by its access URL — stripping it
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
      message: "This title is an external Editor's Pick — it must keep a valid access URL.",
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
