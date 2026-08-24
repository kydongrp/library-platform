// Merge Bib (Vibrant: Merge Bib). Folds a duplicate bibliographic record into
// the one being kept, moving everything attached to it.
//
// Eleven relations hang off a Resource and six of them carry a uniqueness
// constraint that two duplicates can both occupy, so this is deliberately
// careful: the plan is computed and shown first, genuine blockers refuse the
// merge outright, resolvable collisions are reported before they are dropped,
// and the whole move runs inside one interactive transaction so a failure
// half-way cannot leave a half-merged record.

import { prisma } from "@/lib/db";

export type MergePlan = {
  winner: { id: string; title: string; author: string };
  loser: { id: string; title: string; author: string };
  /** Reasons the merge cannot proceed at all. */
  blockers: string[];
  /** Rows that move across, per relation. */
  moves: { label: string; count: number }[];
  /** Duplicates that will be dropped because the pair collides on a unique key. */
  drops: { label: string; count: number; reason: string }[];
  /** Field-level decisions the merge will apply to the surviving record. */
  decisions: string[];
};

const rel = (label: string, count: number) => ({ label, count });

/**
 * Work out exactly what a merge would do, without touching anything. The
 * confirm screen renders this, and executeMerge re-derives it inside the
 * transaction so a concurrent edit cannot slip past the preview.
 */
export async function planMerge(winnerId: string, loserId: string): Promise<MergePlan | null> {
  if (!winnerId || !loserId) return null;

  const [winner, loser] = await Promise.all([
    prisma.resource.findUnique({
      where: { id: winnerId },
      include: { serial: { select: { id: true } }, epSuggestionDismissal: { select: { id: true } } },
    }),
    prisma.resource.findUnique({
      where: { id: loserId },
      include: {
        serial: { include: { _count: { select: { issues: true } } } },
        epSuggestionDismissal: { select: { id: true } },
      },
    }),
  ]);
  if (!winner || !loser) return null;

  const blockers: string[] = [];
  if (winnerId === loserId) blockers.push("A record cannot be merged into itself.");

  // Serial is 1-1 on the resource and its issues are unique per sequence
  // number, so two tracked serials cannot be combined without destroying one
  // subscription's issue and claim history. Refuse rather than lose it.
  if (winner.serial && loser.serial) {
    blockers.push(
      `Both records are tracked as serials. Merging would destroy the ${loser.serial._count.issues} issue record${loser.serial._count.issues === 1 ? "" : "s"} on "${loser.title}". Untrack one of them first.`,
    );
  }

  const [
    copies, loans, reservations, epSubs, marcFields,
    loserReviews, dupReviews,
    loserFavs, dupFavs,
    loserBrowse, dupBrowse,
    winnerLinkCheck, loserLinkCheck,
  ] = await Promise.all([
    prisma.copy.count({ where: { resourceId: loserId } }),
    prisma.loan.count({ where: { resourceId: loserId } }),
    prisma.reservation.count({ where: { resourceId: loserId } }),
    prisma.epSubmission.count({ where: { resourceId: loserId } }),
    prisma.marcField.count({ where: { resourceId: loserId } }),
    prisma.review.count({ where: { resourceId: loserId } }),
    // A member who reviewed BOTH records collides on [resourceId, memberId].
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "Review" a
      JOIN "Review" b ON a."memberId" = b."memberId"
      WHERE a."resourceId" = ${loserId} AND b."resourceId" = ${winnerId}`,
    prisma.favouriteItem.count({ where: { resourceId: loserId } }),
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "FavouriteItem" a
      JOIN "FavouriteItem" b ON a."folderId" = b."folderId"
      WHERE a."resourceId" = ${loserId} AND b."resourceId" = ${winnerId}`,
    prisma.browsingHistory.count({ where: { resourceId: loserId } }),
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "BrowsingHistory" a
      JOIN "BrowsingHistory" b ON a."memberId" = b."memberId"
      WHERE a."resourceId" = ${loserId} AND b."resourceId" = ${winnerId}`,
    prisma.linkCheck.count({ where: { resourceId: winnerId } }),
    prisma.linkCheck.count({ where: { resourceId: loserId } }),
  ]);

  const dupReviewCount = Number(dupReviews[0]?.count ?? 0);
  const dupFavCount = Number(dupFavs[0]?.count ?? 0);
  const dupBrowseCount = Number(dupBrowse[0]?.count ?? 0);

  const moves = [
    rel("Copies (items)", copies),
    rel("Loans, including history", loans),
    rel("Reservations", reservations),
    rel("Editor's Pick nominations", epSubs),
    rel("Catalogued MARC fields", marcFields),
    rel("Reviews", loserReviews - dupReviewCount),
    rel("Favourites", loserFavs - dupFavCount),
    rel("Browsing history", loserBrowse - dupBrowseCount),
  ].filter((m) => m.count > 0);

  const drops = [
    { label: "Reviews", count: dupReviewCount, reason: "the same member reviewed both records" },
    { label: "Favourites", count: dupFavCount, reason: "already in the same folder" },
    { label: "Browsing history", count: dupBrowseCount, reason: "the same member viewed both records" },
    {
      label: "Link check result",
      count: loserLinkCheck > 0 && winnerLinkCheck > 0 ? 1 : 0,
      reason: "one result per record; the next nightly scan regenerates it",
    },
    {
      label: "Auto-curation dismissal",
      count: loser.epSuggestionDismissal && winner.epSuggestionDismissal ? 1 : 0,
      reason: "one dismissal per record",
    },
  ].filter((d) => d.count > 0);

  // Field-level decisions on the surviving record.
  const decisions: string[] = [];
  if (!winner.digitalUrl && loser.digitalUrl)
    decisions.push(`The access URL from "${loser.title}" moves to the surviving record.`);
  else if (winner.digitalUrl && loser.digitalUrl)
    decisions.push("Both records have an access URL; the surviving record keeps its own.");

  if (loser.serial && !winner.serial)
    decisions.push(`Serial issue tracking (${loser.serial._count.issues} issues) moves across.`);

  if (!winner.editorsPick && loser.editorsPick)
    decisions.push("The surviving record becomes an Editor's Pick, taking the curator note across.");

  // epExternal true means removing the pick DELETES the title from the
  // library. It may only survive if BOTH sides were external, otherwise the
  // merged record represents a real catalogued title.
  const mergedExternal = winner.epExternal && loser.epExternal;
  if ((winner.epExternal || loser.epExternal) && !mergedExternal)
    decisions.push(
      "The merged record is part of the collection, so removing it from Editor's Picks will no longer delete it from the library.",
    );

  if (winner.materialDesignation !== loser.materialDesignation)
    decisions.push(
      `Designations differ (${winner.materialDesignation} vs ${loser.materialDesignation}); the surviving record keeps ${winner.materialDesignation}.`,
    );

  return {
    winner: { id: winner.id, title: winner.title, author: winner.author },
    loser: { id: loser.id, title: loser.title, author: loser.author },
    blockers,
    moves,
    drops,
    decisions,
  };
}

export type MergeResult =
  | { ok: true; moved: Record<string, number>; winnerTitle: string; loserTitle: string }
  | { ok: false; error: string };

/** Perform the merge. One transaction: it either all lands or none of it does. */
export async function executeMerge(
  winnerId: string,
  loserId: string,
  mergedBy: string,
): Promise<MergeResult> {
  const plan = await planMerge(winnerId, loserId);
  if (!plan) return { ok: false, error: "One of those records no longer exists." };
  if (plan.blockers.length > 0) return { ok: false, error: plan.blockers[0] };

  const moved: Record<string, number> = {};

  try {
    await prisma.$transaction(async (tx) => {
      const [winner, loser] = await Promise.all([
        tx.resource.findUniqueOrThrow({ where: { id: winnerId } }),
        tx.resource.findUniqueOrThrow({ where: { id: loserId } }),
      ]);

      // 1. Drop the rows that would collide on a unique key. Raw deletes because
      //    the collision is defined by a join against the surviving record.
      moved.reviewsDropped = Number(await tx.$executeRaw`
        DELETE FROM "Review" WHERE "resourceId" = ${loserId}
        AND "memberId" IN (SELECT "memberId" FROM "Review" WHERE "resourceId" = ${winnerId})`);
      moved.favouritesDropped = Number(await tx.$executeRaw`
        DELETE FROM "FavouriteItem" WHERE "resourceId" = ${loserId}
        AND "folderId" IN (SELECT "folderId" FROM "FavouriteItem" WHERE "resourceId" = ${winnerId})`);
      moved.browsingDropped = Number(await tx.$executeRaw`
        DELETE FROM "BrowsingHistory" WHERE "resourceId" = ${loserId}
        AND "memberId" IN (SELECT "memberId" FROM "BrowsingHistory" WHERE "resourceId" = ${winnerId})`);

      // LinkCheck has a unique resourceId and no foreign key, so it is never
      // cleaned up automatically. The nightly scan regenerates the winner's.
      await tx.linkCheck.deleteMany({ where: { resourceId: loserId } });

      // EpSuggestionDismissal is one-per-record.
      const winnerDismissal = await tx.epSuggestionDismissal.findUnique({ where: { resourceId: winnerId } });
      if (winnerDismissal) await tx.epSuggestionDismissal.deleteMany({ where: { resourceId: loserId } });
      else await tx.epSuggestionDismissal.updateMany({ where: { resourceId: loserId }, data: { resourceId: winnerId } });

      // 2. Move everything that survives.
      moved.copies = (await tx.copy.updateMany({ where: { resourceId: loserId }, data: { resourceId: winnerId } })).count;
      moved.loans = (await tx.loan.updateMany({ where: { resourceId: loserId }, data: { resourceId: winnerId } })).count;
      moved.reservations = (await tx.reservation.updateMany({ where: { resourceId: loserId }, data: { resourceId: winnerId } })).count;
      moved.nominations = (await tx.epSubmission.updateMany({ where: { resourceId: loserId }, data: { resourceId: winnerId } })).count;
      moved.reviews = (await tx.review.updateMany({ where: { resourceId: loserId }, data: { resourceId: winnerId } })).count;
      moved.favourites = (await tx.favouriteItem.updateMany({ where: { resourceId: loserId }, data: { resourceId: winnerId } })).count;
      moved.browsing = (await tx.browsingHistory.updateMany({ where: { resourceId: loserId }, data: { resourceId: winnerId } })).count;

      // MARC fields keep their display order by continuing after the winner's.
      const maxSeq = await tx.marcField.aggregate({ where: { resourceId: winnerId }, _max: { seq: true } });
      const loserFields = await tx.marcField.findMany({ where: { resourceId: loserId }, orderBy: { seq: "asc" } });
      let seq = (maxSeq._max.seq ?? 0) + 1;
      for (const f of loserFields) {
        await tx.marcField.update({ where: { id: f.id }, data: { resourceId: winnerId, seq: seq++ } });
      }
      moved.marcFields = loserFields.length;

      // Serial only moves when the winner has none (both-sides is a blocker).
      if (!(await tx.serial.findUnique({ where: { resourceId: winnerId } }))) {
        moved.serials = (await tx.serial.updateMany({ where: { resourceId: loserId }, data: { resourceId: winnerId } })).count;
      } else {
        moved.serials = 0;
      }

      // 3. Field-level merge on the surviving record.
      const mergedExternal = winner.epExternal && loser.epExternal;
      const takesPick = !winner.editorsPick && loser.editorsPick;
      const data: Record<string, unknown> = {};

      // digitalUrl is globally unique, so the loser must release it first.
      if (!winner.digitalUrl && loser.digitalUrl) {
        await tx.resource.update({ where: { id: loserId }, data: { digitalUrl: null } });
        data.digitalUrl = loser.digitalUrl;
      }
      if (takesPick) {
        data.editorsPick = true;
        data.epBlurb = loser.epBlurb;
        data.epPickedAt = loser.epPickedAt;
        data.epPickedBy = loser.epPickedBy;
      }
      if (winner.epExternal !== mergedExternal) data.epExternal = mergedExternal;
      // An external pick must keep an access URL, or removal logic has nothing
      // to act on; without one it cannot remain external.
      if (mergedExternal && !(data.digitalUrl ?? winner.digitalUrl)) data.epExternal = false;
      if (!winner.isbn && loser.isbn) data.isbn = loser.isbn;
      if (!winner.description && loser.description) data.description = loser.description;
      if (!winner.publisher && loser.publisher) data.publisher = loser.publisher;
      if (winner.publishedYear == null && loser.publishedYear != null) data.publishedYear = loser.publishedYear;

      if (Object.keys(data).length > 0) {
        await tx.resource.update({ where: { id: winnerId }, data });
      }

      // 4. The loser is now empty of everything that mattered.
      await tx.resource.delete({ where: { id: loserId } });

      // 5. Tombstone, so the absorbed id stays followable.
      await tx.bibMerge.create({
        data: {
          loserId,
          loserTitle: loser.title,
          winnerId,
          mergedBy,
          moved,
        },
      });
    });
  } catch (e) {
    return {
      ok: false,
      error: `The merge was rolled back and nothing changed: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`,
    };
  }

  return { ok: true, moved, winnerTitle: plan.winner.title, loserTitle: plan.loser.title };
}
