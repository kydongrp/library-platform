"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { providerFor, type ScholarlyRecord } from "@/lib/scholarly";
import { CATEGORIES, RESOURCE_TYPES } from "@/lib/constants";
import type { BulkRow } from "@/lib/bulk-import";
import { coverColorFor, importResourceRowsCore } from "@/lib/ingest";

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

export type BulkImportOptions = {
  provider: string; // already resolved (custom provider substituted client-side)
  defaultType: string;
  defaultCategory: string;
};

export type BulkImportChunkResult = {
  ok: boolean;
  imported: number;
  duplicates: number;
  skipped: number;
  skipReasons: string[];
  error?: string; // set only on a hard failure (permission, bad payload)
};

// Server guard: the client sends far smaller chunks, but bound the payload.
const MAX_CHUNK_ROWS = 500;

/**
 * Import a chunk of already-parsed rows as digital link-out resources under a
 * single provider. The batch file is parsed in the browser and streamed here
 * in small chunks, so upload size is unbounded. Dedups against the catalogue on
 * the access URL (one query per chunk) and bulk-inserts with createMany. The
 * batch provider tag stays independent of each row's real publisher; ISBN and
 * subtitle (e.g. from MARCXML) are preserved. Rows lacking a title or a valid
 * URL are skipped and reported, never silently dropped.
 */
export async function importResourceRows(
  rows: BulkRow[],
  opts: BulkImportOptions,
): Promise<BulkImportChunkResult> {
  const zero = { ok: false, imported: 0, duplicates: 0, skipped: 0, skipReasons: [] as string[] };

  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "CATALOGUE"))
    return { ...zero, error: "You don't have permission to import into the catalogue." };

  const provider = String(opts?.provider ?? "").trim();
  if (!provider) return { ...zero, error: "Choose or enter a provider for the batch." };
  if (!Array.isArray(rows)) return { ...zero, error: "Malformed import payload." };
  if (rows.length > MAX_CHUNK_ROWS)
    return { ...zero, error: `Too many rows in one request (max ${MAX_CHUNK_ROWS}).` };

  const r = await importResourceRowsCore(rows, {
    provider,
    defaultType: opts.defaultType,
    defaultCategory: opts.defaultCategory,
  });
  if (r.imported > 0) revalidatePath("/admin/catalogue");
  return { ok: true, ...r };
}
