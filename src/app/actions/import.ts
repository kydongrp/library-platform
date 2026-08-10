"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { providerFor, type ScholarlyRecord } from "@/lib/scholarly";
import { CATEGORIES, RESOURCE_TYPES } from "@/lib/constants";
import { parseBulk } from "@/lib/bulk-import";

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

type DedupKey = Pick<ScholarlyRecord, "url" | "oaUrl" | "title" | "authors">;

async function alreadyImported(record: DedupKey): Promise<boolean> {
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
      isbn: record.isbn ?? null,
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

/**
 * Add a single scholarly article by hand — for subscription sources with no
 * search API (Janes, Knovel, IHS, etc.). Creates a digital, link-out resource
 * tagged with the chosen provider.
 */
export async function addManualArticle(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "CATALOGUE"))
    return { ok: false, message: "You don't have permission to add to the catalogue." };

  const title = String(formData.get("title") ?? "").trim();
  const url = String(formData.get("url") ?? "").trim();
  if (!title) return { ok: false, message: "Title is required." };
  if (!/^https?:\/\//i.test(url))
    return { ok: false, message: "A valid access URL (https://…) is required." };

  // Provider: a known one, or a custom value the admin typed.
  const rawProvider = String(formData.get("provider") ?? "").trim();
  const customProvider = String(formData.get("customProvider") ?? "").trim();
  const provider =
    rawProvider === "__custom__" ? customProvider : rawProvider;
  if (!provider) return { ok: false, message: "Choose or enter a provider." };

  const type = String(formData.get("type") ?? "JOURNAL");
  const rawType = (RESOURCE_TYPES as readonly string[]).includes(type) ? type : "JOURNAL";
  const rawCategory = String(formData.get("category") ?? "");
  const category = (CATEGORIES as readonly string[]).includes(rawCategory) ? rawCategory : "Technology";
  const yearRaw = String(formData.get("year") ?? "").trim();
  const year = yearRaw ? parseInt(yearRaw, 10) : null;

  const record: ScholarlyRecord = {
    source: "manual",
    externalId: url.toLowerCase(),
    title,
    authors: String(formData.get("authors") ?? "").trim() || "Unknown",
    year: Number.isFinite(year as number) ? year : null,
    publisher: provider,
    venue: String(formData.get("venue") ?? "").trim() || null,
    type: rawType,
    url,
    oaUrl: null,
    abstract: String(formData.get("abstract") ?? "").trim() || null,
  };

  if (await alreadyImported(record))
    return { ok: false, message: "That article (same URL or title) is already in the catalogue." };

  await prisma.resource.create({
    data: {
      title: record.title,
      author: record.authors,
      type: record.type,
      category,
      publisher: provider,
      publishedYear: record.year,
      description: record.abstract,
      coverColor: coverColorFor(provider + title),
      digital: true,
      digitalUrl: url,
      provider, // exact provider chosen (Janes, etc.) — bypasses providerFor mapping
      subtitle: record.venue,
    },
  });

  revalidatePath("/admin/catalogue");
  return { ok: true, message: `Added "${title}" (${provider}).` };
}

/**
 * Bulk-import a batch file (Janes XML, an Excel/CSV export, or JSON) as digital
 * link-out resources tagged with a single provider. Reuses the same dedup and
 * creation path as the search-based importer. Rows missing a title or a valid
 * URL are skipped and reported rather than silently dropped.
 */
export async function bulkImportArticles(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "CATALOGUE"))
    return { ok: false, message: "You don't have permission to import into the catalogue." };

  // Provider for the whole batch (a known one, or a custom value).
  const rawProvider = String(formData.get("provider") ?? "").trim();
  const customProvider = String(formData.get("customProvider") ?? "").trim();
  const provider = rawProvider === "__custom__" ? customProvider : rawProvider;
  if (!provider) return { ok: false, message: "Choose or enter a provider for the batch." };

  const rawCategory = String(formData.get("category") ?? "");
  const defaultCategory = (CATEGORIES as readonly string[]).includes(rawCategory)
    ? rawCategory
    : "Technology";
  const rawType = String(formData.get("type") ?? "JOURNAL");
  const defaultType = (RESOURCE_TYPES as readonly string[]).includes(rawType) ? rawType : "JOURNAL";

  // Content: an uploaded file wins; otherwise fall back to pasted text.
  const file = formData.get("file");
  let content = "";
  let filename: string | undefined;
  if (file && typeof file === "object" && "text" in file && (file as File).size > 0) {
    content = await (file as File).text();
    filename = (file as File).name;
  } else {
    content = String(formData.get("pasted") ?? "");
  }
  if (!content.trim())
    return { ok: false, message: "Upload a file or paste records to import." };

  const { format, rows, errors } = parseBulk(content, filename);
  if (rows.length === 0)
    return { ok: false, message: errors[0] ?? "No records found — check the file format (CSV, JSON, XML, or MARCXML)." };

  let imported = 0;
  let duplicates = 0;
  let skipped = 0;
  const skipReasons: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.title) {
      skipped++;
      if (skipReasons.length < 5) skipReasons.push(`record ${i + 1}: missing title`);
      continue;
    }
    if (!/^https?:\/\//i.test(row.url)) {
      skipped++;
      if (skipReasons.length < 5) skipReasons.push(`record ${i + 1}: missing/invalid URL`);
      continue;
    }
    const authors = row.authors ?? "Unknown";
    // Dedup on the access URL only: for link-out resources the URL is the
    // identity. Matching on title+author would wrongly collapse distinct
    // records that share a title (e.g. multi-volume sets, unnamed serials).
    const existing = await prisma.resource.findFirst({
      where: { digitalUrl: row.url },
      select: { id: true },
    });
    if (existing) {
      duplicates++;
      continue;
    }
    // Create directly (not via importOne) so the batch's provider tag stays
    // independent of the record's real bibliographic publisher, and ISBN /
    // subtitle from MARCXML are preserved.
    await prisma.resource.create({
      data: {
        title: row.title,
        subtitle: row.venue,
        author: authors,
        isbn: row.isbn,
        type: row.type ?? defaultType,
        category: row.category ?? defaultCategory,
        publisher: row.publisher,
        publishedYear: row.year,
        description: row.abstract,
        coverColor: coverColorFor(provider + row.title),
        digital: true,
        digitalUrl: row.url,
        provider,
      },
    });
    imported++;
  }

  revalidatePath("/admin/catalogue");

  const parts = [`${imported} imported`];
  if (duplicates > 0) parts.push(`${duplicates} already in catalogue`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  let message = `${provider} batch (${format.toUpperCase()}): ${parts.join(" · ")}.`;
  const notes = [...errors, ...skipReasons];
  if (notes.length) message += ` — ${notes.slice(0, 6).join("; ")}`;
  // An all-duplicate batch is a successful no-op, not an error (matches importScholarly).
  return { ok: imported > 0 || duplicates > 0, message };
}
