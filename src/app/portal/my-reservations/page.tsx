import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, Badge, BookCover, EmptyState, ButtonLink } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { cancelReservation } from "@/app/actions/circulation";
import { getCurrentMember } from "@/lib/session";
import { formatDate } from "@/lib/format";

export default async function MyReservationsPage() {
  const member = await getCurrentMember();
  if (!member) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-14">
        <EmptyState
          title="Sign in to see your holds"
          description="Choose an account to view and manage your reservations."
          action={<ButtonLink href="/portal/signin">Sign in</ButtonLink>}
        />
      </div>
    );
  }

  const reservations = await prisma.reservation.findMany({
    where: { memberId: member.id, status: { in: ["PENDING", "READY"] } },
    include: { resource: true },
    orderBy: { reservedAt: "asc" },
  });

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <h1 className="font-display text-3xl font-semibold">My Holds</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {reservations.length} active hold{reservations.length === 1 ? "" : "s"}
      </p>

      {reservations.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            title="No holds yet"
            description="When a title has no copies available, you can place a hold and we'll notify you when it's ready."
            action={<ButtonLink href="/portal">Browse the collection</ButtonLink>}
          />
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {reservations.map((r) => (
            <Card key={r.id} className="flex items-center gap-4 p-4">
              <Link href={`/portal/resource/${r.resourceId}`}>
                <BookCover title={r.resource.title} author={r.resource.author} color={r.resource.coverColor} type={r.resource.type} size="sm" />
              </Link>
              <div className="min-w-0 flex-1">
                <Link href={`/portal/resource/${r.resourceId}`} className="font-medium hover:underline">{r.resource.title}</Link>
                <p className="text-sm text-muted-foreground">{r.resource.author}</p>
                <p className="mt-1 text-xs text-muted-foreground">Placed {formatDate(r.reservedAt)}</p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <Badge tone={r.status === "READY" ? "accent" : "muted"}>
                  {r.status === "READY" ? "Ready for pickup" : "Waiting"}
                </Badge>
                <ActionButton action={cancelReservation} fields={{ reservationId: r.id }} variant="outline" className="!px-3 !py-1.5 text-xs" confirm="Cancel this hold?" pendingLabel="…">Cancel</ActionButton>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
