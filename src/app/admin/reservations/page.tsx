import { requireAdminView } from "@/lib/admin-guard";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { cancelReservation } from "@/app/actions/circulation";
import { formatDate } from "@/lib/format";
import { canEdit } from "@/lib/admin-session";
import {
  LIVE_BOOKING_STATUSES,
  BOOKING_STATUS_LABELS,
  describeWindow,
  isCollectable,
} from "@/lib/booking-core";
import {
  NewBookingForm,
  ConfirmBookingButton,
  CollectBookingButton,
  CancelBookingButton,
  NoShowButton,
} from "./booking-widgets";

export const dynamic = "force-dynamic";

export default async function ReservationsPage() {
  const admin = await requireAdminView("RESERVATIONS");
  const editable = canEdit(admin, "RESERVATIONS") || canEdit(admin, "CIRCULATION");
  const now = new Date();

  const [reservations, bookings, recentlyClosed] = await Promise.all([
    prisma.reservation.findMany({
      where: { status: { in: ["PENDING", "READY"] } },
      include: { member: true, resource: true },
      orderBy: [{ status: "asc" }, { reservedAt: "asc" }],
    }),
    // Rows 52-53: live bookings, soonest window first.
    prisma.booking.findMany({
      where: { status: { in: [...LIVE_BOOKING_STATUSES] } },
      include: {
        member: { select: { id: true, name: true } },
        copy: { include: { resource: { select: { id: true, title: true } } } },
      },
      orderBy: { startAt: "asc" },
      take: 200,
    }),
    // A short tail of settled bookings, so a collection or a no-show does not
    // simply vanish from the screen the moment it is recorded.
    prisma.booking.findMany({
      where: { status: { in: ["COLLECTED", "CANCELLED", "NO_SHOW"] } },
      include: {
        member: { select: { id: true, name: true } },
        copy: { include: { resource: { select: { id: true, title: true } } } },
      },
      orderBy: { decidedAt: "desc" },
      take: 8,
    }),
  ]);

  const ready = reservations.filter((r) => r.status === "READY");
  const pending = reservations.filter((r) => r.status === "PENDING");
  // "Ready" for a booking means the window is open right now (row 53).
  const collectable = bookings.filter((b) => isCollectable(b, now));
  const upcoming = bookings.filter((b) => !isCollectable(b, now) && b.endAt > now);
  const lapsed = bookings.filter((b) => b.endAt <= now);

  // datetime-local wants a local wall-clock string, not an ISO instant.
  const pad = (n: number) => String(n).padStart(2, "0");
  const defaultStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-5">
        <h1 className="font-display text-3xl font-semibold">Reservations &amp; bookings</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          {ready.length} hold{ready.length === 1 ? "" : "s"} ready for pickup · {pending.length} waiting
          {bookings.length > 0 && ` · ${bookings.length} live booking${bookings.length === 1 ? "" : "s"}`}.
          A hold queues for a title that is out; a booking holds one specific
          item for a set window.
        </p>
      </div>

      {reservations.length === 0 && bookings.length === 0 ? (
        <EmptyState
          title="No holds or bookings"
          description="Holds appear when a member reserves a title with no copies free. Bookings are made below, for a specific item over a set window."
        />
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

          {collectable.length > 0 && (
            <section>
              <h2 className="mb-2 font-display text-lg font-semibold">
                Bookings ready to collect
              </h2>
              <Card className="divide-y divide-border overflow-hidden">
                {collectable.map((b) => (
                  <BookingRow key={b.id} b={b} editable={editable} collectable />
                ))}
              </Card>
            </section>
          )}

          {upcoming.length > 0 && (
            <section>
              <h2 className="mb-2 font-display text-lg font-semibold">Upcoming bookings</h2>
              <Card className="divide-y divide-border overflow-hidden">
                {upcoming.map((b) => (
                  <BookingRow key={b.id} b={b} editable={editable} />
                ))}
              </Card>
            </section>
          )}

          {lapsed.length > 0 && (
            <section>
              <h2 className="mb-2 font-display text-lg font-semibold">Windows that have closed</h2>
              <p className="mb-2 text-xs text-muted-foreground">
                Booked but never collected. Recording a no-show keeps the item history honest.
              </p>
              <Card className="divide-y divide-border overflow-hidden">
                {lapsed.map((b) => (
                  <BookingRow key={b.id} b={b} editable={editable} lapsed />
                ))}
              </Card>
            </section>
          )}
        </div>
      )}

      {editable && (
        <section className="mt-8">
          <h2 className="mb-1 font-display text-lg font-semibold">Book an item</h2>
          <p className="mb-3 max-w-3xl text-xs text-muted-foreground">
            Holds one specific copy for a window. Overlapping bookings on the same
            copy are refused, and a booking handed over becomes an ordinary loan
            due at the end of its window.
          </p>
          <Card className="p-5">
            <NewBookingForm defaultStart={defaultStart} />
          </Card>
        </section>
      )}

      {recentlyClosed.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 font-display text-lg font-semibold">Recently settled</h2>
          <Card className="divide-y divide-border overflow-hidden">
            {recentlyClosed.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {b.copy.resource.title}
                  <span className="text-muted-foreground"> · {b.copy.barcode} · {b.member.name}</span>
                </span>
                <span className="text-xs text-muted-foreground">{describeWindow(b)}</span>
                <Badge tone={b.status === "COLLECTED" ? "success" : "muted"}>
                  {BOOKING_STATUS_LABELS[b.status] ?? b.status}
                </Badge>
              </div>
            ))}
          </Card>
        </section>
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

function BookingRow({
  b,
  editable,
  collectable = false,
  lapsed = false,
}: {
  b: {
    id: string;
    status: string;
    startAt: Date;
    endAt: Date;
    note: string | null;
    memberId: string;
    member: { name: string };
    copy: { barcode: string; status: string; resource: { id: string; title: string } };
  };
  editable: boolean;
  collectable?: boolean;
  lapsed?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <Link href={`/admin/catalogue/${b.copy.resource.id}`} className="truncate font-medium hover:underline">
          {b.copy.resource.title}
        </Link>
        <p className="truncate text-sm text-muted-foreground">
          <span className="font-mono text-xs">{b.copy.barcode}</span>
          {" · "}
          <Link href={`/admin/members/${b.memberId}`} className="hover:underline">{b.member.name}</Link>
          {" · "}{describeWindow(b)}
          {b.note ? ` · ${b.note}` : ""}
        </p>
      </div>
      <Badge tone={b.status === "CONFIRMED" ? "success" : "muted"}>
        {BOOKING_STATUS_LABELS[b.status] ?? b.status}
      </Badge>
      {collectable && b.copy.status !== "AVAILABLE" && (
        <Badge tone="danger">item {b.copy.status.toLowerCase().replace(/_/g, " ")}</Badge>
      )}
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          {b.status === "REQUESTED" && !lapsed && <ConfirmBookingButton bookingId={b.id} />}
          {collectable && b.status === "CONFIRMED" && b.copy.status === "AVAILABLE" && (
            <CollectBookingButton bookingId={b.id} who={b.member.name.split(" ")[0]} />
          )}
          {lapsed && <NoShowButton bookingId={b.id} />}
          <CancelBookingButton bookingId={b.id} label={b.copy.barcode} />
        </div>
      )}
    </div>
  );
}
