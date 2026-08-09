import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { BookCover, Badge, Card, ButtonLink, buttonVariants } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { checkout, reserve, checkin, cancelReservation } from "@/app/actions/circulation";
import { getCurrentMember } from "@/lib/session";
import { availability, isDigital, isExternal } from "@/lib/availability";
import { TermsGate } from "./terms-gate";
import { ReviewForm } from "./reviews";
import { BookmarkButton } from "./bookmark";
import { Stars } from "@/components/stars";
import { initials } from "@/lib/format";
import { RESOURCE_TYPE_LABELS } from "@/lib/constants";
import { formatDate, dueLabel, isOverdue } from "@/lib/format";

export default async function ResourceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const member = await getCurrentMember();

  const resource = await prisma.resource.findUnique({
    where: { id },
    include: { copies: true },
  });
  if (!resource) notFound();

  const digital = isDigital(resource);
  const external = isExternal(resource);
  const avail = availability(resource);

  const [myLoan, myHold, waiting] = member && !external
    ? await Promise.all([
        prisma.loan.findFirst({
          where: { memberId: member.id, resourceId: id, status: "ACTIVE" },
        }),
        prisma.reservation.findFirst({
          where: { memberId: member.id, resourceId: id, status: { in: ["PENDING", "READY"] } },
        }),
        prisma.reservation.count({ where: { resourceId: id, status: "PENDING" } }),
      ])
    : [null, null, 0];

  // Concurrent access management for seat-limited digital titles.
  const seatsInUse =
    digital && resource.licenseSeats != null
      ? await prisma.loan.count({ where: { resourceId: id, status: "ACTIVE" } })
      : 0;
  const seatFree =
    !digital || resource.licenseSeats == null || seatsInUse < resource.licenseSeats;

  // Contract FR 8.1: T&Cs must be accepted before accessing digital resources.
  const needsTerms = (digital || external) && !!member && !member.tcAcceptedAt;

  const [reviews, ratingAgg] = await Promise.all([
    prisma.review.findMany({
      where: { resourceId: id },
      include: { member: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
    prisma.review.aggregate({
      where: { resourceId: id },
      _avg: { rating: true },
      _count: { _all: true },
    }),
  ]);
  const myReview = member ? reviews.find((r) => r.memberId === member.id) ?? null : null;
  const avgRating = ratingAgg._avg.rating ?? 0;
  const reviewCount = ratingAgg._count._all;

  // Favourites state for the bookmark control.
  const folders = member
    ? (
        await prisma.favouriteFolder.findMany({
          where: { memberId: member.id },
          include: { items: { where: { resourceId: id }, select: { id: true } } },
          orderBy: { createdAt: "asc" },
        })
      ).map((f) => ({ id: f.id, name: f.name, contains: f.items.length > 0 }))
    : [];
  if (member && folders.length === 0) {
    // The default folder is created lazily on first save; show it as an option.
    folders.push({ id: "", name: "My Favourites", contains: false });
  }

  // Record browsing history (SDD: My Browsing History) — re-views bump the timestamp.
  if (member) {
    await prisma.browsingHistory.upsert({
      where: { memberId_resourceId: { memberId: member.id, resourceId: id } },
      update: { viewedAt: new Date() },
      create: { memberId: member.id, resourceId: id },
    });
  }

  return (
    <div className="mx-auto max-w-4xl px-5 py-8">
      <Link href="/portal" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back to browse
      </Link>

      <div className="mt-4 flex flex-col gap-8 sm:flex-row">
        <div className="mx-auto sm:mx-0">
          <BookCover title={resource.title} author={resource.author} color={resource.coverColor} type={resource.type} size="lg" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="neutral">{RESOURCE_TYPE_LABELS[resource.type] ?? resource.type}</Badge>
            <Link href={`/portal/search?category=${encodeURIComponent(resource.category)}`}>
              <Badge tone="muted">{resource.category}</Badge>
            </Link>
          </div>
          <h1 className="mt-2 font-display text-3xl font-semibold">{resource.title}</h1>
          {resource.subtitle && <p className="text-lg text-muted-foreground">{resource.subtitle}</p>}
          <p className="mt-1 text-lg text-foreground/80">{resource.author}</p>
          {reviewCount > 0 && (
            <p className="mt-1.5 flex items-center gap-2 text-sm text-muted-foreground">
              <Stars rating={avgRating} />
              {avgRating.toFixed(1)} · {reviewCount} review{reviewCount === 1 ? "" : "s"}
            </p>
          )}

          <div className="mt-4">
            <Badge tone={avail.state === "unavailable" ? "danger" : avail.state === "available" ? "success" : "primary"}>
              {avail.label}
            </Badge>
            {digital && resource.licenseSeats != null && (
              <span className="ml-2 text-sm text-muted-foreground">
                {seatsInUse} of {resource.licenseSeats} licence seat{resource.licenseSeats === 1 ? "" : "s"} in use
              </span>
            )}
            {waiting > 0 && (
              <span className="ml-2 text-sm text-muted-foreground">
                · {waiting} {waiting === 1 ? "person" : "people"} waiting
              </span>
            )}
          </div>

          {/* Action panel */}
          <div className="mt-5">
            {!member && (digital || external) ? (
              <div className="flex flex-col gap-2">
                <ButtonLink href="/portal/signin">
                  {external ? `Sign in to access via ${resource.provider}` : "Sign in to borrow"}
                </ButtonLink>
                <p className="text-xs text-muted-foreground">
                  Digital resources require sign-in and acceptance of the usage terms.
                </p>
              </div>
            ) : needsTerms ? (
              <TermsGate provider={resource.provider} />
            ) : external ? (
              <div className="flex flex-col gap-2">
                <a
                  href={resource.digitalUrl || "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants.primary}
                >
                  Read on {resource.provider} ↗
                </a>
                <p className="text-xs text-muted-foreground">
                  Full text is hosted by {resource.provider}. Access is included with your
                  institutional subscription.
                </p>
              </div>
            ) : !member ? (
              <ButtonLink href="/portal/signin">Sign in to borrow</ButtonLink>
            ) : myLoan ? (
              <Card className="flex flex-wrap items-center gap-3 p-4">
                <Badge tone={isOverdue(myLoan.dueAt) ? "danger" : "primary"}>
                  {digital ? "Instant access" : "On loan to you"} · {dueLabel(myLoan.dueAt)}
                </Badge>
                {digital ? (
                  <ActionButton action={checkin} fields={{ loanId: myLoan.id }} variant="outline" className="!py-1.5 text-xs">
                    Return early
                  </ActionButton>
                ) : (
                  <span className="text-sm text-muted-foreground">Return it at the circulation desk.</span>
                )}
              </Card>
            ) : myHold ? (
              <Card className="flex flex-wrap items-center gap-3 p-4">
                <Badge tone="accent">
                  {myHold.status === "READY" ? "Ready for pickup" : "Hold placed — you're in the queue"}
                </Badge>
                <ActionButton action={cancelReservation} fields={{ reservationId: myHold.id }} variant="outline" className="!py-1.5 text-xs" confirm="Cancel this hold?">
                  Cancel hold
                </ActionButton>
              </Card>
            ) : (digital && seatFree) || avail.state === "available" ? (
              <ActionButton action={checkout} fields={{ memberId: member.id, resourceId: resource.id }} pendingLabel="Borrowing…">
                {digital ? "Borrow — instant access" : "Borrow this title"}
              </ActionButton>
            ) : (
              <div className="flex flex-col gap-2">
                <ActionButton action={reserve} fields={{ memberId: member.id, resourceId: resource.id }} variant="accent" pendingLabel="Placing hold…">
                  Place a hold
                </ActionButton>
                {digital && !seatFree && (
                  <p className="text-xs text-muted-foreground">
                    All {resource.licenseSeats} licence seat{resource.licenseSeats === 1 ? " is" : "s are"} in
                    use. You&apos;ll be notified when one frees up.
                  </p>
                )}
              </div>
            )}
          </div>

          {member && (
            <div className="mt-3">
              <BookmarkButton resourceId={resource.id} folders={folders} />
            </div>
          )}

          {resource.description && (
            <p className="mt-6 leading-relaxed text-foreground/80">{resource.description}</p>
          )}

          <dl className="mt-6 grid grid-cols-2 gap-y-2 text-sm">
            {resource.publisher && (<><dt className="text-muted-foreground">Publisher</dt><dd>{resource.publisher}</dd></>)}
            {resource.publishedYear && (<><dt className="text-muted-foreground">Published</dt><dd>{resource.publishedYear}</dd></>)}
            <dt className="text-muted-foreground">Language</dt><dd>{resource.language}</dd>
            {resource.isbn && (<><dt className="text-muted-foreground">ISBN</dt><dd className="font-mono text-xs">{resource.isbn}</dd></>)}
            {!digital && (<><dt className="text-muted-foreground">Added</dt><dd>{formatDate(resource.createdAt)}</dd></>)}
          </dl>
        </div>
      </div>

      {/* Reviews */}
      <section className="mt-12 max-w-3xl">
        <h2 className="mb-4 font-display text-2xl font-semibold">
          Reviews {reviewCount > 0 && <span className="text-base font-normal text-muted-foreground">({reviewCount})</span>}
        </h2>

        {member ? (
          <ReviewForm
            resourceId={resource.id}
            existing={myReview ? { id: myReview.id, rating: myReview.rating, text: myReview.text } : null}
          />
        ) : (
          <p className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
            <Link href="/portal/signin" className="text-primary hover:underline">Sign in</Link> to rate and review this title.
          </p>
        )}

        {reviews.filter((r) => r.id !== myReview?.id).length > 0 && (
          <ul className="mt-5 space-y-4">
            {reviews
              .filter((r) => r.id !== myReview?.id)
              .map((r) => (
                <li key={r.id} className="flex gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {initials(r.member.name)}
                  </span>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{r.member.name}</span>
                      <Stars rating={r.rating} size="text-sm" />
                      <span className="text-xs text-muted-foreground">{formatDate(r.updatedAt)}</span>
                    </p>
                    {r.text && <p className="mt-1 text-sm text-foreground/80">{r.text}</p>}
                  </div>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}
