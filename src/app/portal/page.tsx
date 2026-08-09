import Link from "next/link";
import { prisma } from "@/lib/db";
import { PortalSearch } from "@/components/portal-search";
import { ResourceCard } from "@/components/resource-card";
import { getCurrentMember } from "@/lib/session";
import { CATEGORIES } from "@/lib/constants";

const cardSelect = {
  id: true, title: true, author: true, coverColor: true,
  type: true, category: true, digital: true, provider: true,
  copies: { select: { status: true } },
} as const;

type CardData = Parameters<typeof ResourceCard>[0]["resource"];

/** Personalised rails (live system: editorspick / areaofinterestprofile /
 *  recommendpastloans / recommendpastsearches). Rule-based equivalents. */
async function personalRails(member: { id: string; interests: string[] }) {
  const [editorsPick, myLoans, mySearches] = await Promise.all([
    prisma.resource.findMany({ where: { editorsPick: true }, take: 6, select: cardSelect }),
    prisma.loan.findMany({
      where: { memberId: member.id },
      include: { resource: { select: { category: true, author: true } } },
      orderBy: { borrowedAt: "desc" },
      take: 10,
    }),
    prisma.searchHistory.findMany({
      where: { memberId: member.id },
      orderBy: { searchedAt: "desc" },
      take: 5,
    }),
  ]);

  const loanedIds = new Set(
    (await prisma.loan.findMany({ where: { memberId: member.id }, select: { resourceId: true } })).map(
      (l) => l.resourceId,
    ),
  );

  // For your interests: titles in the member's chosen AOI categories.
  const interests: CardData[] = member.interests.length
    ? (
        await prisma.resource.findMany({
          where: { category: { in: member.interests } },
          orderBy: { createdAt: "desc" },
          take: 12,
          select: cardSelect,
        })
      )
        .filter((r) => !loanedIds.has(r.id))
        .slice(0, 6)
    : [];

  // Based on past loans: same categories as recent loans, minus already-borrowed.
  const loanCategories = [...new Set(myLoans.map((l) => l.resource.category))];
  const pastLoans: CardData[] = loanCategories.length
    ? (
        await prisma.resource.findMany({
          where: { category: { in: loanCategories } },
          orderBy: { createdAt: "desc" },
          take: 12,
          select: cardSelect,
        })
      )
        .filter((r) => !loanedIds.has(r.id))
        .slice(0, 6)
    : [];

  // Based on past searches: title/author contains any recent search term.
  const terms = [...new Set(mySearches.map((s) => s.query.trim()).filter((t) => t.length >= 3))];
  const pastSearches: CardData[] = terms.length
    ? (
        await prisma.resource.findMany({
          where: {
            OR: terms.flatMap((t) => [
              { title: { contains: t, mode: "insensitive" as const } },
              { author: { contains: t, mode: "insensitive" as const } },
            ]),
          },
          take: 6,
          select: cardSelect,
        })
      ).slice(0, 6)
    : [];

  return { editorsPick, interests, pastLoans, pastSearches };
}

export default async function PortalHome() {
  const member = await getCurrentMember();

  const [newest, digital, external, available, topRated] = await Promise.all([
    prisma.resource.findMany({ orderBy: { createdAt: "desc" }, take: 6, select: cardSelect }),
    prisma.resource.findMany({ where: { digital: true, provider: null }, take: 6, select: cardSelect }),
    prisma.resource.findMany({ where: { provider: { not: null } }, take: 6, select: cardSelect }),
    prisma.resource.findMany({
      where: { copies: { some: { status: "AVAILABLE" } } },
      take: 6,
      select: cardSelect,
    }),
    // Highly rated (contract FR 8.1): best average rating among reviewed titles.
    prisma.review
      .groupBy({
        by: ["resourceId"],
        _avg: { rating: true },
        _count: { _all: true },
        orderBy: [{ _avg: { rating: "desc" } }, { _count: { resourceId: "desc" } }],
        take: 6,
      })
      .then((groups) =>
        groups.length
          ? prisma.resource
              .findMany({
                where: { id: { in: groups.map((g) => g.resourceId) } },
                select: cardSelect,
              })
              .then((rs) => {
                const order = new Map(groups.map((g, i) => [g.resourceId, i]));
                return rs.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
              })
          : [],
      ),
  ]);

  const rails = member
    ? await personalRails({ id: member.id, interests: member.interests })
    : null;

  return (
    <div>
      {/* Hero */}
      <section className="hero-paper border-b border-border">
        <div className="mx-auto max-w-3xl px-5 py-16 text-center">
          <h1 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">
            {member ? `Welcome back, ${member.name.split(" ")[0]}` : "Discover your next read"}
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
            Search thousands of titles, borrow digital resources instantly, and reserve
            what&apos;s out — all in one place.
          </p>
          <div className="mx-auto mt-7 max-w-xl">
            <PortalSearch size="lg" />
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {CATEGORIES.map((c) => (
              <Link
                key={c}
                href={`/portal/search?category=${encodeURIComponent(c)}`}
                className="rounded-full border border-border bg-card px-3.5 py-1.5 text-sm text-stone-700 shadow-sm transition-colors hover:border-primary hover:text-primary"
              >
                {c}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {!member && (
        <div className="border-b border-border bg-accent-soft">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3 text-sm">
            <span className="text-accent">
              Sign in to borrow titles, place holds, and track your loans.
            </span>
            <Link href="/portal/signin" className="shrink-0 font-medium text-accent underline">
              Sign in
            </Link>
          </div>
        </div>
      )}

      <div className="mx-auto max-w-6xl space-y-12 px-5 py-12">
        {rails && (
          <>
            {member && member.interests.length === 0 && (
              <div className="rounded-xl border border-dashed border-primary/40 bg-primary/5 px-5 py-4 text-sm">
                <span className="font-medium text-primary">Make this page yours:</span>{" "}
                <Link href="/portal/preferences" className="text-primary underline">
                  pick your areas of interest
                </Link>{" "}
                and we&apos;ll recommend titles that match.
              </div>
            )}
            <Shelf title="Editor's Pick" href="/portal/search" resources={rails.editorsPick} />
            <Shelf title="For your interests" href="/portal/preferences" resources={rails.interests} />
            <Shelf title="Based on your past loans" href="/portal/my-loans" resources={rails.pastLoans} />
            <Shelf title="Based on your past searches" href="/portal/history" resources={rails.pastSearches} />
          </>
        )}
        <Shelf title="Available right now" href="/portal/search?availability=available" resources={available} />
        <Shelf title="Highly rated" href="/portal/search?sort=rating" resources={topRated} />
        <Shelf title="Research databases & journals" href="/portal/search?availability=external" resources={external} />
        <Shelf title="Instant digital access" href="/portal/search?availability=digital" resources={digital} />
        <Shelf title="New to the shelves" href="/portal/search?sort=newest" resources={newest} />
      </div>
    </div>
  );
}

function Shelf({
  title,
  href,
  resources,
}: {
  title: string;
  href: string;
  resources: Parameters<typeof ResourceCard>[0]["resource"][];
}) {
  if (resources.length === 0) return null;
  return (
    <section>
      <div className="mb-5 flex items-end justify-between">
        <h2 className="font-display text-2xl font-semibold">{title}</h2>
        <Link href={href} className="text-sm font-medium text-primary hover:underline">
          See all →
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-6">
        {resources.map((r) => (
          <ResourceCard key={r.id} resource={r} />
        ))}
      </div>
    </section>
  );
}
