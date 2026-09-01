/**
 * The common-cover pool, and assignment of one cover per new bib record.
 *
 * The selection rule lives in the pure module (src/lib/cover-match.ts); this is
 * the database side: load the candidate pool once, hand it to the rule, and
 * report what happened so an import can say "12 covers assigned" instead of
 * changing records silently.
 *
 * Server-side only: it touches prisma.
 */
import { prisma } from "@/lib/db";
import {
  chooseCover, tokenFromFileName, randomIndex,
  type CoverCandidate, type CoverTarget, type CoverMatchTier, type IndexPicker,
} from "@/lib/cover-match";

/**
 * Never load image BYTES here. Assignment needs the id and the token only, and
 * a pool of a hundred covers would otherwise pull megabytes into memory on
 * every import batch.
 */
export async function loadCoverPool(): Promise<CoverCandidate[]> {
  const rows = await prisma.coverImage.findMany({
    where: { enabled: true },
    select: { id: true, token: true },
    orderBy: { fileName: "asc" },
  });
  return rows;
}

export type CoverAssignment = {
  /** Null when the pool offered nothing suitable; the record keeps coverColor. */
  coverImageId: string | null;
  matchedOn: CoverMatchTier | null;
};

/** One record's cover, from an already-loaded pool. */
export function assignFromPool(
  target: CoverTarget,
  pool: CoverCandidate[],
  pick: IndexPicker = randomIndex,
): CoverAssignment {
  const choice = chooseCover(target, pool, pick);
  return { coverImageId: choice?.id ?? null, matchedOn: choice?.matchedOn ?? null };
}

export type CoverTally = { assigned: number; collection: number; publisher: number; general: number };

export function emptyTally(): CoverTally {
  return { assigned: 0, collection: 0, publisher: 0, general: 0 };
}

export function countAssignment(tally: CoverTally, a: CoverAssignment): void {
  if (!a.coverImageId || !a.matchedOn) return;
  tally.assigned++;
  tally[a.matchedOn]++;
}

/** "9 covers assigned (4 by collection, 3 by publisher, 2 general)", or null. */
export function describeTally(tally: CoverTally): string | null {
  if (tally.assigned === 0) return null;
  const parts: string[] = [];
  if (tally.collection) parts.push(`${tally.collection} by collection`);
  if (tally.publisher) parts.push(`${tally.publisher} by publisher`);
  if (tally.general) parts.push(`${tally.general} general`);
  return `${tally.assigned} cover${tally.assigned === 1 ? "" : "s"} assigned (${parts.join(", ")})`;
}

/**
 * The collections and publishers a file name could usefully be named after,
 * for the admin screen. Publishers come from the catalogue itself rather than a
 * managed list, because that is the only place they exist.
 */
export async function knownMatchTargets(): Promise<{ collections: string[]; publishers: string[] }> {
  const [categories, publishers] = await Promise.all([
    prisma.resourceCategory.findMany({ select: { name: true }, orderBy: { name: "asc" } }),
    prisma.resource.findMany({
      where: { publisher: { not: null } },
      select: { publisher: true },
      distinct: ["publisher"],
      orderBy: { publisher: "asc" },
      take: 200,
    }),
  ]);
  return {
    collections: categories.map((c) => c.name),
    publishers: publishers.map((p) => p.publisher!).filter(Boolean),
  };
}

/**
 * Backfill: give covers to records that have none.
 *
 * Assignment normally happens at import, so this exists for the pool's first
 * upload, when a catalogue of records already exists with nothing to point at.
 * Capped, and it only ever fills a null: it never replaces a cover a record
 * already has, so running it twice is safe and running it after staff have
 * chosen covers by hand does not overwrite their work.
 */
export async function backfillCovers(
  limit = 500,
  pick: IndexPicker = randomIndex,
): Promise<CoverTally & { considered: number }> {
  const pool = await loadCoverPool();
  const tally = { ...emptyTally(), considered: 0 };
  if (pool.length === 0) return tally;

  const rows = await prisma.resource.findMany({
    where: { coverImageId: null },
    select: { id: true, category: true, publisher: true },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(limit, 5000)),
  });
  tally.considered = rows.length;

  for (const r of rows) {
    const a = assignFromPool({ collection: r.category, publisher: r.publisher }, pool, pick);
    if (!a.coverImageId) continue;
    // Conditioned on coverImageId still being null, so a concurrent import or a
    // staff edit between the read above and here wins instead of being clobbered.
    const res = await prisma.resource.updateMany({
      where: { id: r.id, coverImageId: null },
      data: { coverImageId: a.coverImageId },
    });
    if (res.count === 1) countAssignment(tally, a);
  }
  return tally;
}

/** Token for a file name, re-exported so callers need one import, not two. */
export { tokenFromFileName };
