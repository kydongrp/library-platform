"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { DIGITAL_TYPES } from "@/lib/constants";

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
  const data = parseResourceForm(formData);
  if (!data.title) return { ok: false, message: "Title is required." };
  if (!data.author) return { ok: false, message: "Author is required." };

  const copyCount = data.digital
    ? 0
    : Math.max(0, parseInt(String(formData.get("copyCount") ?? "1"), 10) || 0);
  const barcodes = await nextBarcodes(copyCount);

  const resource = await prisma.resource.create({
    data: {
      ...data,
      copies: { create: barcodes.map((barcode) => ({ barcode })) },
    },
  });

  revalidatePath("/admin/catalogue");
  redirect(`/admin/catalogue/${resource.id}`);
}

export async function updateResource(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "");
  const data = parseResourceForm(formData);
  if (!id) return { ok: false, message: "Missing resource id." };
  if (!data.title || !data.author)
    return { ok: false, message: "Title and author are required." };

  await prisma.resource.update({ where: { id }, data });
  revalidatePath(`/admin/catalogue/${id}`);
  revalidatePath("/admin/catalogue");
  return { ok: true, message: "Saved." };
}

export async function deleteResource(formData: FormData): Promise<void> {
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
  await prisma.resource.delete({ where: { id } });
  revalidatePath("/admin/catalogue");
  redirect("/admin/catalogue");
}

export async function addCopies(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const resourceId = String(formData.get("resourceId") ?? "");
  const count = Math.max(1, parseInt(String(formData.get("count") ?? "1"), 10) || 1);
  const location = String(formData.get("location") ?? "Main Shelf");
  if (!resourceId) return { ok: false, message: "Missing resource." };

  const barcodes = await nextBarcodes(count);
  await prisma.copy.createMany({
    data: barcodes.map((barcode) => ({ resourceId, barcode, location })),
  });
  revalidatePath(`/admin/catalogue/${resourceId}`);
  return { ok: true, message: `Added ${count} cop${count === 1 ? "y" : "ies"}.` };
}

export async function setCopyStatus(formData: FormData): Promise<void> {
  const copyId = String(formData.get("copyId") ?? "");
  const status = String(formData.get("status") ?? "");
  const resourceId = String(formData.get("resourceId") ?? "");
  if (!copyId || !status) return;
  // Don't override a copy that's actively on loan.
  const copy = await prisma.copy.findUnique({ where: { id: copyId } });
  if (copy && copy.status !== "ON_LOAN") {
    await prisma.copy.update({ where: { id: copyId }, data: { status } });
  }
  revalidatePath(`/admin/catalogue/${resourceId}`);
}

export async function deleteCopy(formData: FormData): Promise<void> {
  const copyId = String(formData.get("copyId") ?? "");
  const resourceId = String(formData.get("resourceId") ?? "");
  if (!copyId) return;
  const copy = await prisma.copy.findUnique({ where: { id: copyId } });
  if (copy && copy.status !== "ON_LOAN") {
    await prisma.copy.delete({ where: { id: copyId } });
  }
  revalidatePath(`/admin/catalogue/${resourceId}`);
}
