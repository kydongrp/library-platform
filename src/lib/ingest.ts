// Shared import pipeline: turn parsed rows into catalogue resources, and the
// scheduled SFTP re-fetch that feeds vendor batch files through it. Server-only
// (imports prisma + the SFTP adapter). No admin-session checks here — callers
// authorise (an admin session for the manual trigger, CRON_SECRET for cron).
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { parseBulk, type BulkRow } from "@/lib/bulk-import";
import { CATEGORIES, RESOURCE_TYPES } from "@/lib/constants";
import { sftpConfigured, sftpSourceInfo, fetchNewSftpFiles } from "@/lib/sftp";
import type { Prisma } from "@/generated/prisma/client";

// Deterministic cover colour per seed so imports look organised.
const COVER_COLORS = [
  "#00629b", "#1e3a8a", "#0f766e", "#9a3412", "#6d28d9",
  "#155e75", "#7c2d12", "#1d4044", "#b45309", "#312e81",
];
export function coverColorFor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return COVER_COLORS[Math.abs(h) % COVER_COLORS.length];
}

export type ImportRowsOptions = {
  provider: string;
  defaultType: string;
  defaultCategory: string;
};

export type ImportRowsResult = {
  imported: number;
  duplicates: number;
  skipped: number;
  skipReasons: string[];
};

const DEDUP_BATCH = 1000; // URLs per existence query
const CREATE_BATCH = 500; // rows per createMany (well under Postgres param limit)

/**
 * Core row importer, shared by the browser-chunked manual importer and the
 * SFTP job. Validates each row (title + http(s) URL), dedups on the access URL
 * (the identity for link-out resources), and bulk-inserts. No auth, no
 * revalidate — the caller owns both.
 */
export async function importResourceRowsCore(
  rows: BulkRow[],
  opts: ImportRowsOptions,
): Promise<ImportRowsResult> {
  const provider = String(opts.provider ?? "").trim();
  const defaultType = (RESOURCE_TYPES as readonly string[]).includes(opts.defaultType)
    ? opts.defaultType
    : "JOURNAL";
  const defaultCategory = (CATEGORIES as readonly string[]).includes(opts.defaultCategory)
    ? opts.defaultCategory
    : "Technology";

  let skipped = 0;
  const skipReasons: string[] = [];
  const valid: BulkRow[] = [];
  rows.forEach((row, i) => {
    if (!row?.title || !String(row.title).trim()) {
      skipped++;
      if (skipReasons.length < 5) skipReasons.push(`row ${i + 1}: missing title`);
      return;
    }
    if (!/^https?:\/\//i.test(String(row.url ?? ""))) {
      skipped++;
      if (skipReasons.length < 5) skipReasons.push(`row ${i + 1}: missing/invalid URL`);
      return;
    }
    valid.push(row);
  });

  if (valid.length === 0) return { imported: 0, duplicates: 0, skipped, skipReasons };

  // Dedup on access URL — batched existence queries.
  const urls = Array.from(new Set(valid.map((r) => r.url)));
  const seen = new Set<string>();
  for (let i = 0; i < urls.length; i += DEDUP_BATCH) {
    const existing = await prisma.resource.findMany({
      where: { digitalUrl: { in: urls.slice(i, i + DEDUP_BATCH) } },
      select: { digitalUrl: true },
    });
    existing.forEach((e) => e.digitalUrl && seen.add(e.digitalUrl));
  }

  let duplicates = 0;
  const toCreate: Prisma.ResourceCreateManyInput[] = [];
  for (const row of valid) {
    if (seen.has(row.url)) {
      duplicates++;
      continue;
    }
    seen.add(row.url); // collapse repeats within this batch too
    const type =
      row.type && (RESOURCE_TYPES as readonly string[]).includes(row.type) ? row.type : defaultType;
    const category =
      row.category && (CATEGORIES as readonly string[]).includes(row.category)
        ? row.category
        : defaultCategory;
    toCreate.push({
      title: String(row.title).trim(),
      subtitle: row.venue ?? null,
      author: row.authors ?? "Unknown",
      isbn: row.isbn ?? null,
      type,
      category,
      publisher: row.publisher ?? null,
      publishedYear: typeof row.year === "number" ? row.year : null,
      description: row.abstract ?? null,
      coverColor: coverColorFor(provider + row.title),
      digital: true,
      digitalUrl: row.url,
      provider,
    });
  }

  let imported = 0;
  for (let i = 0; i < toCreate.length; i += CREATE_BATCH) {
    const batch = toCreate.slice(i, i + CREATE_BATCH);
    await prisma.resource.createMany({ data: batch });
    imported += batch.length;
  }

  return { imported, duplicates, skipped, skipReasons };
}

/* ---------- Scheduled SFTP re-fetch ---------- */

const SFTP_SOURCE = "sftp";
const MAX_FILES_PER_RUN = 20; // bound work per invocation (serverless time)

export type SftpRunSummary = {
  status: "success" | "skipped" | "error";
  filesFound: number;
  filesImported: number;
  resourcesImported: number;
  duplicates: number;
  skipped: number;
  message: string;
};

/**
 * Poll the configured SFTP source, import any batch files not seen before, and
 * record a BatchRun. Idempotent: each filename is imported once per source
 * (tracked in ImportedFile). A bad file is recorded and skipped, never aborting
 * the whole run.
 */
export async function runSftpFetch(trigger: "cron" | "manual"): Promise<SftpRunSummary> {
  const ranBy = trigger === "cron" ? "cron" : "admin";

  if (!sftpConfigured()) {
    const message = "SFTP source not configured — set SFTP_HOST, SFTP_USER, credentials and SFTP_PROVIDER.";
    await prisma.batchRun.create({ data: { process: "SFTP_FETCH", summary: `Skipped — ${message}`, ranBy } });
    revalidatePath("/admin/batch");
    return { status: "skipped", filesFound: 0, filesImported: 0, resourcesImported: 0, duplicates: 0, skipped: 0, message };
  }

  const source = sftpSourceInfo()!;
  try {
    const done = await prisma.importedFile.findMany({
      where: { source: SFTP_SOURCE },
      select: { filename: true },
    });
    const processed = new Set(done.map((d) => d.filename));

    const { files, totalNew } = await fetchNewSftpFiles(processed, MAX_FILES_PER_RUN);

    let resourcesImported = 0;
    let duplicates = 0;
    let skipped = 0;
    let filesImported = 0;
    for (const file of files) {
      try {
        const { rows } = parseBulk(file.content, file.filename);
        const res = await importResourceRowsCore(rows, {
          provider: source.provider,
          defaultType: "EBOOK",
          defaultCategory: source.defaultCategory,
        });
        resourcesImported += res.imported;
        duplicates += res.duplicates;
        skipped += res.skipped;
        filesImported++;
        await prisma.importedFile.create({
          data: {
            source: SFTP_SOURCE,
            filename: file.filename,
            resourcesImported: res.imported,
            status: "OK",
            detail: `${res.imported} imported · ${res.duplicates} dup · ${res.skipped} skipped`,
          },
        });
      } catch (e) {
        // Record the bad file so it is not retried forever, and keep going.
        await prisma.importedFile.create({
          data: {
            source: SFTP_SOURCE,
            filename: file.filename,
            status: "PARSE_ERROR",
            detail: e instanceof Error ? e.message.slice(0, 300) : "parse failed",
          },
        });
      }
    }

    const capped = totalNew > files.length ? ` (${totalNew - files.length} more queued for next run)` : "";
    const message =
      files.length === 0
        ? `No new files in ${source.host}:${source.remoteDir}.`
        : `${filesImported}/${files.length} file(s) from ${source.host} · ${resourcesImported} imported · ${duplicates} dup · ${skipped} skipped${capped}`;

    await prisma.batchRun.create({ data: { process: "SFTP_FETCH", summary: message, ranBy } });
    if (resourcesImported > 0) revalidatePath("/admin/catalogue");
    revalidatePath("/admin/batch");
    return { status: "success", filesFound: files.length, filesImported, resourcesImported, duplicates, skipped, message };
  } catch (e) {
    const message = `SFTP fetch failed: ${e instanceof Error ? e.message : "connection error"}`;
    await prisma.batchRun.create({ data: { process: "SFTP_FETCH", summary: message.slice(0, 300), ranBy } });
    revalidatePath("/admin/batch");
    return { status: "error", filesFound: 0, filesImported: 0, resourcesImported: 0, duplicates: 0, skipped: 0, message };
  }
}
