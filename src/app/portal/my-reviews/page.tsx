import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentMember } from "@/lib/session";
import { Card, EmptyState, ButtonLink, BookCover } from "@/components/ui";
import { Stars } from "@/components/stars";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ star?: string }>;

export default async function MyReviewsPage({ searchParams }: { searchParams: SearchParams }) {
  const member = await getCurrentMember();
  if (!member) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-14">
        <EmptyState
          title="Sign in to see your reviews"
          description="Your ratings and reviews across the collection live here."
          action={<ButtonLink href="/portal/signin">Sign in</ButtonLink>}
        />
      </div>
    );
  }

  const { star = "" } = await searchParams;
  const starFilter = parseInt(star, 10);
  const hasFilter = Number.isFinite(starFilter) && starFilter >= 1 && starFilter <= 5;

  const reviews = await prisma.review.findMany({
    where: { memberId: member.id, ...(hasFilter && { rating: starFilter }) },
    include: { resource: true },
    orderBy: { updatedAt: "desc" },
  });

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <h1 className="font-display text-3xl font-semibold">My Reviews</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {reviews.length} review{reviews.length === 1 ? "" : "s"}
        {hasFilter && ` with ${starFilter} star${starFilter === 1 ? "" : "s"}`}
      </p>

      {/* Star filter (live system: review star filters) */}
      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href="/portal/my-reviews"
          className={`rounded-full px-3.5 py-1.5 text-sm ${!hasFilter ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}
        >
          All
        </Link>
        {[5, 4, 3, 2, 1].map((n) => (
          <Link
            key={n}
            href={`/portal/my-reviews?star=${n}`}
            className={`rounded-full px-3.5 py-1.5 text-sm ${starFilter === n ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}
          >
            {n}★
          </Link>
        ))}
      </div>

      {reviews.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            title={hasFilter ? "No reviews with this rating" : "No reviews yet"}
            description="Open any title and share what you thought of it."
            action={<ButtonLink href="/portal">Browse the collection</ButtonLink>}
          />
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {reviews.map((r) => (
            <Card key={r.id} className="flex items-center gap-4 p-4">
              <Link href={`/portal/resource/${r.resourceId}`}>
                <BookCover title={r.resource.title} author={r.resource.author} color={r.resource.coverColor} type={r.resource.type} size="sm" />
              </Link>
              <div className="min-w-0 flex-1">
                <Link href={`/portal/resource/${r.resourceId}`} className="font-medium hover:underline">
                  {r.resource.title}
                </Link>
                <p className="mt-0.5 flex items-center gap-2 text-sm">
                  <Stars rating={r.rating} size="text-sm" />
                  <span className="text-xs text-muted-foreground">{formatDate(r.updatedAt)}</span>
                </p>
                {r.text && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{r.text}</p>}
              </div>
              <Link href={`/portal/resource/${r.resourceId}`} className="shrink-0 text-sm text-primary hover:underline">
                Edit →
              </Link>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
