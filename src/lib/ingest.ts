// Shared import pipeline: turn parsed rows into catalogue resources, and the
// scheduled SFTP re-fetch that feeds vendor batch files through it. Server-only
// (imports prisma + the SFTP adapter). No admin-session checks here: callers
// authorise (an admin session for the manual trigger, CRON_SECRET for cron).
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { parseBulk, type BulkRow } from "@/lib/bulk-import";
import { RESOURCE_TYPES, UNCATEGORISED, defaultDesignationFor } from "@/lib/constants";
import {
  loadCoverPool, assignFromPool, emptyTally, countAssignment, describeTally,
  type CoverTally,
} from "@/lib/cover-images";
import {
  attachSourceMarc, emptyMarcTally, addMarcTally, describeMarcTally, type MarcTally,
} from "@/lib/marc-store";
import type { SourceField } from "@/lib/marc-source";
import { sftpConfigured, sftpSourceInfo, fetchNewSftpFiles } from "@/lib/sftp";
import { audit } from "@/lib/audit";
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
};

export type ImportRowsResult = {
  imported: number;
  duplicates: number;
  skipped: number;
  skipReasons: string[];
  /**
   * Common cover images assigned to the new records, as counts rather than a
   * sentence: the bulk path imports in chunks, and numbers add up across them
   * where a formatted string would not.
   */
  coverTally: CoverTally;
  /**
   * Source MARC kept on the records. Counts rather than a sentence, for the
   * same chunking reason as the covers above.
   */
  marcTally: MarcTally;
};

const DEDUP_BATCH = 1000; // URLs per existence query
const CREATE_BATCH = 500; // rows per createMany (well under Postgres param limit)

/**
 * Core row importer, shared by the browser-chunked manual importer and the
 * SFTP job. Validates each row (title + http(s) URL), dedups on the access URL
 * (the identity for link-out resources), and bulk-inserts. No auth, no
 * revalidate: the caller owns both.
 */
export async function importResourceRowsCore(
  rows: BulkRow[],
  opts: ImportRowsOptions,
): Promise<ImportRowsResult> {
  const provider = String(opts.provider ?? "").trim();
  const defaultType = (RESOURCE_TYPES as readonly string[]).includes(opts.defaultType)
    ? opts.defaultType
    : "JOURNAL";

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

  if (valid.length === 0) {
    return { imported: 0, duplicates: 0, skipped, skipReasons, coverTally: emptyTally(), marcTally: emptyMarcTally() };
  }

  // Source MARC, keyed by access URL, collected from EVERY valid row rather
  // than only the ones about to be created. A row the dedup below rejects as
  // already present is the case that matters most: it is how a record imported
  // before this pipeline kept MARC gets its MARC, by re-uploading the file it
  // came from. Later rows win a key clash, matching the createMany behaviour
  // where the last write of a repeated URL is the one that stands.
  const marcByUrl = new Map<string, SourceField[]>();
  for (const row of valid) {
    if (Array.isArray(row.marc) && row.marc.length > 0) marcByUrl.set(row.url, row.marc);
  }

  // Dedup on access URL, using batched existence queries.
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
    // the collection's sources. Claim it as internal so removing it from the
    // picks later can't delete a vendor-supplied title (it stays deduped here).
    await prisma.resource.updateMany({
      where: { digitalUrl: { in: batch }, epExternal: true },
      data: { epExternal: false },
    });
  }

  // One query for the whole batch. A per-row lookup would issue thousands of
  // queries on a 50,000-row import for a value that cannot change mid-run.
  const coverPool = await loadCoverPool();
  const coverTally = emptyTally();

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
    const cover = assignFromPool(
      { collection: UNCATEGORISED, publisher: row.publisher ?? null },
      coverPool,
    );
    countAssignment(coverTally, cover);
    toCreate.push({
      title: String(row.title).trim(),
      subtitle: row.venue ?? null,
      author: row.authors ?? "Unknown",
      isbn: row.isbn ?? null,
      type,
      // Imported records get the bib-level designation their type implies.
      materialDesignation: defaultDesignationFor(type),
      // Everything imported lands Uncategorised. Classifying at import time
      // was slow and usually wrong: whoever loads a batch is rarely whoever
      // decides its subject. Staff filter the catalogue for Uncategorised and
      // classify from there.
      category: UNCATEGORISED,
      publisher: row.publisher ?? null,
      publishedYear: typeof row.year === "number" ? row.year : null,
      description: row.abstract ?? null,
      coverColor: coverColorFor(provider + row.title),
      // A common cover if the pool has a suitable one, else null and the
      // coloured placeholder stands. These rows land Uncategorised (see just
      // above), as do LiveFetch's, so at import time a cover is matched on
      // PUBLISHER or falls back to a general image. Collection-matched covers
      // arrive when staff classify, via the backfill on the covers screen.
      coverImageId: cover.coverImageId,
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
    let res;
    try {
      res = await prisma.resource.createMany({ data: batch, skipDuplicates: true });
    } catch (e) {
      // P2003 is a foreign-key violation, and the only foreign key here is the
      // cover image: staff deleted one between loadCoverPool above and this
      // insert. A decorative cover must never cost a batch of catalogue
      // records, so retry once with the covers stripped. The records land; the
      // backfill on the covers screen can dress them later.
      if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2003") {
        const bare = batch.map((row) => ({ ...row, coverImageId: null }));
        res = await prisma.resource.createMany({ data: bare, skipDuplicates: true });
        // Those rows have no cover, so nothing in this batch may be claimed.
        coverTally.assigned = Math.max(0, coverTally.assigned - batch.length);
      } else {
        throw e;
      }
    }
    imported += res.count;
  }
  // Anything the DB skipped (a race inserted it first) is a duplicate, not new.
  duplicates += toCreate.length - imported;

  // Clamped to what was actually inserted. A cover was chosen for every row
  // PREPARED, but a row the database skipped as a race duplicate never got
  // written, so the unclamped figure could claim more covers than there are
  // new records. Clamping can only understate, which is the safe direction for
  // a number staff read as a result.
  //
  // The TIER counts come down with it. describeTally renders them as a
  // breakdown of the total ("9 covers assigned (4 by collection, 5 general)"),
  // so lowering only the total produced a sentence whose parts exceeded its
  // whole. The overflow comes off the least specific tier first, because a
  // general cover is the one whose loss says least.
  if (coverTally.assigned > imported) {
    let excess = coverTally.assigned - imported;
    coverTally.assigned = imported;
    for (const tier of ["general", "publisher", "collection"] as const) {
      const take = Math.min(excess, coverTally[tier]);
      coverTally[tier] -= take;
      excess -= take;
      if (excess === 0) break;
    }
  }

  // After the resources exist, and deliberately not inside a transaction with
  // them. This file's standing position is that a decorative or secondary
  // failure must never cost a batch of catalogue records (see the P2003 retry
  // above); the same holds here. If attaching MARC fails, the records are
  // already safely in the catalogue with their flat columns, and re-running the
  // import attaches the fields, because attachSourceMarc only ever fills a
  // record that has none.
  let marcTally = emptyMarcTally();
  try {
    marcTally = await attachSourceMarc(marcByUrl);
  } catch {
    /* records stand; re-importing the file attaches their MARC */
  }

  return { imported, duplicates, skipped, skipReasons, coverTally, marcTally };
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
    const message = "SFTP source not configured. Set SFTP_HOST, SFTP_USER, credentials and SFTP_PROVIDER.";
    await prisma.batchRun.create({ data: { process: "SFTP_FETCH", summary: `Skipped: ${message}`, ranBy } });
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
    const sftpCovers = emptyTally();
    const sftpMarc = emptyMarcTally();
    let duplicates = 0;
    let skipped = 0;
    let filesImported = 0;
    for (const file of files) {
      try {
        const { rows } = parseBulk(file.content, file.filename);
        const res = await importResourceRowsCore(rows, {
          provider: source.provider,
          defaultType,
        });
        resourcesImported += res.imported;
        sftpCovers.assigned += res.coverTally.assigned;
        sftpCovers.collection += res.coverTally.collection;
        sftpCovers.publisher += res.coverTally.publisher;
        sftpCovers.general += res.coverTally.general;
        addMarcTally(sftpMarc, res.marcTally);
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
    // Reported so an unattended nightly run says what it did to cover art,
    // rather than staff noticing covers appear and wondering why.
    const coversDescribed = describeTally(sftpCovers);
    const covers = coversDescribed ? ` · ${coversDescribed}` : "";
    // Same reasoning as the covers line: an unattended nightly run should say
    // what it did to the records, not leave staff to notice MARC appear.
    const marcDescribed = describeMarcTally(sftpMarc);
    const marc = marcDescribed ? ` · ${marcDescribed}` : "";
    const message =
      files.length === 0 && oversize.length === 0
        ? `No new files in ${source.host}:${source.remoteDir}.`
        : `${filesImported}/${files.length} file(s) from ${source.host} · ${resourcesImported} imported · ${duplicates} dup · ${skipped} skipped${over}${capped}${covers}${marc}`;

    await prisma.batchRun.create({ data: { process: "SFTP_FETCH", summary: message, ranBy } });
    // The manual trigger audits with the admin's session; cron has no session.
    if (trigger === "cron")
      await audit({ actor: { name: "cron" }, action: "batch.sftpFetch", summary: `Scheduled SFTP fetch: ${message.slice(0, 200)}`, entity: "BatchRun" });
    if (resourcesImported > 0) {
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
