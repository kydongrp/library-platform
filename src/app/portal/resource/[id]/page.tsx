import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { BookCover, Badge, Card, ButtonLink, buttonVariants } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { checkout, reserve, checkin, cancelReservation } from "@/app/actions/circulation";
import { getCurrentMember } from "@/lib/session";
import { availability, isDigital, isExternal } from "@/lib/availability";
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

          <div className="mt-4">
            <Badge tone={avail.state === "unavailable" ? "danger" : avail.state === "available" ? "success" : "primary"}>
              {avail.label}
            </Badge>
            {!digital && waiting > 0 && (
              <span className="ml-2 text-sm text-muted-foreground">
                {waiting} {waiting === 1 ? "person" : "people"} waiting
              </span>
            )}
          </div>

          {/* Action panel */}
          <div className="mt-5">
            {external ? (
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
            ) : digital || avail.state === "available" ? (
              <ActionButton action={checkout} fields={{ memberId: member.id, resourceId: resource.id }} pendingLabel="Borrowing…">
                {digital ? "Borrow — instant access" : "Borrow this title"}
              </ActionButton>
            ) : (
              <ActionButton action={reserve} fields={{ memberId: member.id, resourceId: resource.id }} variant="accent" pendingLabel="Placing hold…">
                Place a hold
              </ActionButton>
            )}
          </div>

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
    </div>
  );
}
