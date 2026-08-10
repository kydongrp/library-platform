"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { providerFor, type ScholarlyRecord } from "@/lib/scholarly";
import { CATEGORIES } from "@/lib/constants";

// Deterministic cover colour per venue/publisher so imports look organised.
const COVER_COLORS = [
  "#00629b", "#1e3a8a", "#0f766e", "#9a3412", "#6d28d9",
  "#155e75", "#7c2d12", "#1d4044", "#b45309", "#312e81",
];
function coverColorFor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return COVER_COLORS[Math.abs(h) % COVER_COLORS.length];
}

async function alreadyImported(record: ScholarlyRecord): Promise<boolean> {
  const existing = await prisma.resource.findFirst({
    where: {
      OR: [
        { digitalUrl: record.url },
        ...(record.oaUrl ? [{ digitalUrl: record.oaUrl }] : []),
        { AND: [{ title: record.title }, { author: record.authors }] },
      ],
    },
    select: { id: true },
  });
  return !!existing;
}

async function importOne(record: ScholarlyRecord, category: string): Promise<"imported" | "duplicate"> {
  if (await alreadyImported(record)) return "duplicate";
  await prisma.resource.create({
    data: {
      title: record.title,
      author: record.authors,
      type: record.type,
      category,
      publisher: record.publisher,
      publishedYear: record.year,
      description: record.abstract,
      coverColor: coverColorFor(record.venue ?? record.publisher ?? record.title),
      digital: true,
      // Prefer the open-access full text when one exists; else the DOI link.
      digitalUrl: record.oaUrl ?? record.url,
      provider: providerFor(record),
      subtitle: record.venue,
    },
  });
  return "imported";
}

function parseRecords(raw: string): ScholarlyRecord[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** Import one or many LiveFetch records into the catalogue. */
export async function importScholarly(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "CATALOGUE"))
    return { ok: false, message: "You don't have permission to import into the catalogue." };

  const records = parseRecords(String(formData.get("records") ?? ""));
  if (records.length === 0) return { ok: false, message: "Nothing to import." };

  const rawCategory = String(formData.get("category") ?? "");
  const category = (CATEGORIES as readonly string[]).includes(rawCategory)
    ? rawCategory
    : "Technology";

  let imported = 0;
  let duplicates = 0;
  for (const record of records) {
    if (!record?.title || !record?.url) continue;
    const result = await importOne(record, category);
    if (result === "imported") imported++;
    else duplicates++;
  }

  revalidatePath("/admin/catalogue");

  const parts = [`${imported} imported`];
  if (duplicates > 0) parts.push(`${duplicates} already in catalogue`);
  return { ok: imported > 0 || duplicates > 0, message: parts.join(" · ") + "." };
}
