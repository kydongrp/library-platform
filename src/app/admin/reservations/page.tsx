import { requireAdminView } from "@/lib/admin-guard";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { cancelReservation } from "@/app/actions/circulation";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ReservationsPage() {
  await requireAdminView("RESERVATIONS");

  const reservations = await prisma.reservation.findMany({
    where: { status: { in: ["PENDING", "READY"] } },
    include: { member: true, resource: true },
    orderBy: [{ status: "asc" }, { reservedAt: "asc" }],
  });

  const ready = reservations.filter((r) => r.status === "READY");
  const pending = reservations.filter((r) => r.status === "PENDING");

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-5">
        <h1 className="font-display text-3xl font-semibold">Reservations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {ready.length} ready for pickup · {pending.length} waiting.
        </p>
      </div>

      {reservations.length === 0 ? (
        <EmptyState title="No active holds" description="Reservations appear here when a member places a hold on a title with no available copies." />
      ) : (
        <div className="space-y-6">
          {ready.length > 0 && (
            <section>
              <h2 className="mb-2 font-display text-lg font-semibold">Ready for pickup</h2>
              <Card className="divide-y divide-border overflow-hidden">
                {ready.map((r) => (
                  <Row key={r.id} r={r} />
                ))}
              </Card>
            </section>
          )}
          {pending.length > 0 && (
            <section>
              <h2 className="mb-2 font-display text-lg font-semibold">Waiting queue</h2>
              <Card className="divide-y divide-border overflow-hidden">
                {pending.map((r) => (
                  <Row key={r.id} r={r} />
                ))}
              </Card>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  r,
}: {
  r: {
    id: string;
    status: string;
    reservedAt: Date;
    readyAt: Date | null;
    memberId: string;
    member: { name: string };
    resource: { id: string; title: string };
  };
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <Link href={`/admin/catalogue/${r.resource.id}`} className="truncate font-medium hover:underline">
          {r.resource.title}
        </Link>
        <p className="truncate text-sm text-muted-foreground">
          <Link href={`/admin/members/${r.memberId}`} className="hover:underline">{r.member.name}</Link>
          {" · placed "}{formatDate(r.reservedAt)}
        </p>
      </div>
      {r.status === "READY" ? (
        <Badge tone="accent">Ready {formatDate(r.readyAt)}</Badge>
      ) : (
        <Badge tone="muted">Waiting</Badge>
      )}
      <ActionButton action={cancelReservation} fields={{ reservationId: r.id }} variant="outline" className="!px-3 !py-1.5 text-xs" confirm="Cancel this hold?" pendingLabel="…">Cancel</ActionButton>
    </div>
  );
}
