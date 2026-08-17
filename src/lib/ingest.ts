// Shared import pipeline: turn parsed rows into catalogue resources, and the
// scheduled SFTP re-fetch that feeds vendor batch files through it. Server-only
// (imports prisma + the SFTP adapter). No admin-session checks here — callers
// authorise (an admin session for the manual trigger, CRON_SECRET for cron).
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { parseBulk, type BulkRow } from "@/lib/bulk-import";
import { CATEGORIES, RESOURCE_TYPES, defaultDesignationFor } from "@/lib/constants";
import { sftpConfigured, sftpSourceInfo, fetchNewSftpFiles } from "@/lib/sftp";
import { audit } from "@/lib/audit";
import { emitEventAfter } from "@/lib/webhooks";
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
    const batch = urls.slice(i, i + DEDUP_BATCH);
    const existing = await prisma.resource.findMany({
      where: { digitalUrl: { in: batch } },
      select: { digitalUrl: true },
    });
    existing.forEach((e) => e.digitalUrl && seen.add(e.digitalUrl));
    // A feed row matching an EXTERNAL Editor's Pick proves the title exists in
    // the collection's sources — claim it as internal so removing it from the
    // picks later can't delete a vendor-supplied title (it stays deduped here).
    await prisma.resource.updateMany({
      where: { digitalUrl: { in: batch }, epExternal: true },
      data: { epExternal: false },
    });
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
      // Imported records get the bib-level designation their type implies.
      materialDesignation: defaultDesignationFor(type),
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
    // skipDuplicates + the unique index on digitalUrl make this safe against a
    // concurrent run inserting the same link-out between our dedup query above
    // and here; count only what was actually inserted.
    const res = await prisma.resource.createMany({ data: batch, skipDuplicates: true });
    imported += res.count;
  }
  // Anything the DB skipped (a race inserted it first) is a duplicate, not new.
  duplicates += toCreate.length - imported;

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
  const defaultType = (RESOURCE_TYPES as readonly string[]).includes(source.defaultType)
    ? source.defaultType
    : "EBOOK";

  // Upsert a per-file record; never let bookkeeping abort the run.
  const recordFile = async (
    filename: string,
    status: string,
    imported: number,
    detail: string,
    mtime: number | null,
    size: number | null,
  ) => {
    const data = {
      resourcesImported: imported,
      status,
      detail: detail.slice(0, 300),
      remoteMtime: mtime != null ? BigInt(Math.trunc(mtime)) : null,
      remoteSize: size != null ? BigInt(Math.trunc(size)) : null,
    };
    try {
      await prisma.importedFile.upsert({
        where: { source_filename: { source: SFTP_SOURCE, filename } },
        update: data,
        create: { source: SFTP_SOURCE, filename, ...data },
      });
    } catch {
      /* bookkeeping failure must not abort the run */
    }
  };

  try {
    const done = await prisma.importedFile.findMany({
      where: { source: SFTP_SOURCE },
      select: { filename: true, remoteMtime: true, remoteSize: true },
    });
    const processed = new Map(
      done.map((d) => [
        d.filename,
        { mtime: d.remoteMtime != null ? Number(d.remoteMtime) : null, size: d.remoteSize != null ? Number(d.remoteSize) : null },
      ]),
    );

    const { files, totalNew, oversize } = await fetchNewSftpFiles(processed, MAX_FILES_PER_RUN);

    for (const o of oversize) {
      await recordFile(o.filename, "SKIPPED_OVERSIZE", 0, `skipped: ${o.size ?? "?"} bytes exceeds limit`, o.mtime, o.size);
    }

    let resourcesImported = 0;
    let duplicates = 0;
    let skipped = 0;
    let filesImported = 0;
    for (const file of files) {
      try {
        const { rows } = parseBulk(file.content, file.filename);
        const res = await importResourceRowsCore(rows, {
          provider: source.provider,
          defaultType,
          defaultCategory: source.defaultCategory,
        });
        resourcesImported += res.imported;
        duplicates += res.duplicates;
        skipped += res.skipped;
        filesImported++;
        await recordFile(
          file.filename,
          "OK",
          res.imported,
          `${res.imported} imported · ${res.duplicates} dup · ${res.skipped} skipped`,
          file.mtime,
          file.size,
        );
      } catch (e) {
        // Record the bad file so it is not retried forever, and keep going.
        await recordFile(
          file.filename,
          "PARSE_ERROR",
          0,
          e instanceof Error ? e.message : "parse failed",
          file.mtime,
          file.size,
        );
      }
    }

    const queued = totalNew - files.length - oversize.length;
    const capped = queued > 0 ? ` (${queued} more queued for next run)` : "";
    const over = oversize.length ? ` · ${oversize.length} too large` : "";
    const message =
      files.length === 0 && oversize.length === 0
        ? `No new files in ${source.host}:${source.remoteDir}.`
        : `${filesImported}/${files.length} file(s) from ${source.host} · ${resourcesImported} imported · ${duplicates} dup · ${skipped} skipped${over}${capped}`;

    await prisma.batchRun.create({ data: { process: "SFTP_FETCH", summary: message, ranBy } });
    // The manual trigger audits with the admin's session; cron has no session.
    if (trigger === "cron")
      await audit({ actor: { name: "cron" }, action: "batch.sftpFetch", summary: `Scheduled SFTP fetch — ${message.slice(0, 200)}`, entity: "BatchRun" });
    if (resourcesImported > 0) {
      emitEventAfter("resources.imported", {
        count: resourcesImported,
        source: "sftp",
        provider: source.provider,
      });
      revalidatePath("/admin/catalogue");
    }
    revalidatePath("/admin/batch");
    return { status: "success", filesFound: files.length, filesImported, resourcesImported, duplicates, skipped, message };
  } catch (e) {
    const message = `SFTP fetch failed: ${e instanceof Error ? e.message : "connection error"}`;
    await prisma.batchRun.create({ data: { process: "SFTP_FETCH", summary: message.slice(0, 300), ranBy } });
    if (trigger === "cron")
      await audit({ actor: { name: "cron" }, action: "batch.sftpFetch", summary: message.slice(0, 200), entity: "BatchRun" });
    revalidatePath("/admin/batch");
    return { status: "error", filesFound: 0, filesImported: 0, resourcesImported: 0, duplicates: 0, skipped: 0, message };
  }
}
