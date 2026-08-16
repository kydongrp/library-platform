// Auto-curation suggestions for the Editor's Pick shelf: a deterministic,
// explainable score over signals the system already records. Every suggestion
// carries the reasons it scored, so staff judge the evidence — nothing is
// promoted automatically.
//
// Signals (per candidate title):
//   demand     — loans in the trailing 90 days
//   holds      — reservations in the trailing 90 days
//   rating     — learner review average (can subtract for poorly-rated titles)
//   freshness  — added to the catalogue within the last 45 days
//   diversity  — its category is missing from the current shelf
// Exclusions: already a pick, staff-dismissed, a REJECTED learner nomination,
// or its access link failed the last scan (never feature a broken link).

import { prisma } from "@/lib/db";

export const DEMAND_WINDOW_DAYS = 90;
export const FRESH_WINDOW_DAYS = 45;
const MAX_SUGGESTIONS = 8;
const DAY_MS = 86_400_000;

export type Suggestion = {
  id: string;
  title: string;
  author: string;
  type: string;
  category: string;
  provider: string | null;
  digital: boolean;
  score: number;
  reasons: string[];
};

export type DismissedSuggestion = {
  resourceId: string;
  title: string;
  dismissedBy: string;
  dismissedAt: Date;
};

export type CurationResult = {
  suggestions: Suggestion[];
  dismissed: DismissedSuggestion[];
};

export async function getCurationSuggestions(now = new Date()): Promise<CurationResult> {
  const demandCutoff = new Date(now.getTime() - DEMAND_WINDOW_DAYS * DAY_MS);
  const freshCutoff = new Date(now.getTime() - FRESH_WINDOW_DAYS * DAY_MS);

  const [loanGroups, resGroups, reviewGroups, shelf, brokenLinks, dismissals, rejected, freshArrivals] =
    await Promise.all([
      prisma.loan.groupBy({
        by: ["resourceId"],
        where: { borrowedAt: { gte: demandCutoff } },
        _count: { _all: true },
      }),
      prisma.reservation.groupBy({
        by: ["resourceId"],
        where: { reservedAt: { gte: demandCutoff } },
        _count: { _all: true },
      }),
      prisma.review.groupBy({
        by: ["resourceId"],
        _avg: { rating: true },
        _count: { _all: true },
      }),
      prisma.resource.findMany({
        where: { editorsPick: true },
        select: { category: true },
      }),
      prisma.linkCheck.findMany({ where: { ok: false }, select: { resourceId: true } }),
      prisma.epSuggestionDismissal.findMany({
        include: { resource: { select: { title: true } } },
        orderBy: { dismissedAt: "desc" },
      }),
      prisma.epSubmission.findMany({
        where: { status: "REJECTED", resourceId: { not: null } },
        select: { resourceId: true },
      }),
      prisma.resource.findMany({
        where: { editorsPick: false, createdAt: { gte: freshCutoff } },
        select: { id: true },
        orderBy: { createdAt: "desc" },
        take: 300, // bound the candidate pool on catalogues with huge import batches
      }),
    ]);

  const loans = new Map(loanGroups.map((g) => [g.resourceId, g._count._all]));
  const holds = new Map(resGroups.map((g) => [g.resourceId, g._count._all]));
  const ratings = new Map(
    reviewGroups.map((g) => [g.resourceId, { avg: g._avg.rating ?? 0, count: g._count._all }]),
  );
  const shelfCategories = new Set(shelf.map((s) => s.category));
  const broken = new Set(brokenLinks.map((b) => b.resourceId));
  const excluded = new Set<string>([
    ...dismissals.map((d) => d.resourceId),
    ...rejected.map((r) => r.resourceId!),
  ]);

  // Candidates = anything carrying a signal. Bounded: signal maps are small
  // (windowed groupBys + capped fresh arrivals), so we never scan the catalogue.
  const candidateIds = new Set<string>([
    ...loans.keys(),
    ...holds.keys(),
    ...ratings.keys(),
    ...freshArrivals.map((r) => r.id),
  ]);
  for (const id of excluded) candidateIds.delete(id);
  for (const id of broken) candidateIds.delete(id);

  if (candidateIds.size === 0)
    return { suggestions: [], dismissed: toDismissed(dismissals) };

  const resources = await prisma.resource.findMany({
    where: { id: { in: [...candidateIds] }, editorsPick: false },
    select: {
      id: true, title: true, author: true, type: true, category: true,
      provider: true, digital: true, createdAt: true,
    },
  });

  const suggestions: Suggestion[] = [];
  for (const r of resources) {
    const reasons: string[] = [];
    let score = 0;

    const loanCount = loans.get(r.id) ?? 0;
    if (loanCount > 0) {
      score += Math.min(loanCount, 10) * 6;
      reasons.push(`${loanCount} loan${loanCount === 1 ? "" : "s"} in ${DEMAND_WINDOW_DAYS} days`);
    }

    const holdCount = holds.get(r.id) ?? 0;
    if (holdCount > 0) {
      score += Math.min(holdCount, 5) * 4;
      reasons.push(`${holdCount} hold${holdCount === 1 ? "" : "s"} waiting`);
    }

    const rating = ratings.get(r.id);
    if (rating && rating.count > 0) {
      // Centred on 2.5: well-rated titles gain, poorly-rated ones lose.
      score += Math.round((rating.avg - 2.5) * Math.min(rating.count, 5) * 2);
      reasons.push(`rated ${rating.avg.toFixed(1)}★ by ${rating.count} member${rating.count === 1 ? "" : "s"}`);
    }

    const ageDays = (now.getTime() - r.createdAt.getTime()) / DAY_MS;
    if (ageDays <= FRESH_WINDOW_DAYS) {
      score += Math.round(15 * (1 - ageDays / FRESH_WINDOW_DAYS));
      reasons.push("new arrival");
    }

    // Diversity is a boost for titles that already earned a positive score —
    // never a reason on its own, and never a rescue for a poorly-rated title.
    if (score > 0 && !shelfCategories.has(r.category)) {
      score += 8;
      reasons.push(`no ${r.category} pick on the shelf yet`);
    }

    if (score <= 0) continue;
    suggestions.push({
      id: r.id, title: r.title, author: r.author, type: r.type,
      category: r.category, provider: r.provider, digital: r.digital,
      score, reasons,
    });
  }

  suggestions.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return {
    suggestions: suggestions.slice(0, MAX_SUGGESTIONS),
    dismissed: toDismissed(dismissals),
  };
}

function toDismissed(
  dismissals: { resourceId: string; dismissedBy: string; dismissedAt: Date; resource: { title: string } }[],
): DismissedSuggestion[] {
  return dismissals.map((d) => ({
    resourceId: d.resourceId,
    title: d.resource.title,
    dismissedBy: d.dismissedBy,
    dismissedAt: d.dismissedAt,
  }));
}
