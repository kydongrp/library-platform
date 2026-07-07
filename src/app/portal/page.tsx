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

export default async function PortalHome() {
  const member = await getCurrentMember();

  const [newest, digital, external, available] = await Promise.all([
    prisma.resource.findMany({ orderBy: { createdAt: "desc" }, take: 6, select: cardSelect }),
    prisma.resource.findMany({ where: { digital: true, provider: null }, take: 6, select: cardSelect }),
    prisma.resource.findMany({ where: { provider: { not: null } }, take: 6, select: cardSelect }),
    prisma.resource.findMany({
      where: { copies: { some: { status: "AVAILABLE" } } },
      take: 6,
      select: cardSelect,
    }),
  ]);

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
        <Shelf title="Available right now" href="/portal/search?availability=available" resources={available} />
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
