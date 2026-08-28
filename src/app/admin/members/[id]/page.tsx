import { requireAdminView } from "@/lib/admin-guard";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { HOLD_QUEUE_ORDER } from "@/lib/hold-queue";
import { Card, Badge } from "@/components/ui";
import { MemberForm } from "@/components/member-form";
import { ActionButton } from "@/components/forms";
import { updateMember } from "@/app/actions/members";
import { checkin, renewLoan, cancelReservation } from "@/app/actions/circulation";
import { MEMBER_TYPE_LABELS } from "@/lib/constants";
import { initials, formatDate, dueLabel, isOverdue } from "@/lib/format";
import { formatFine } from "@/lib/fines";

export default async function MemberDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminView("MEMBERS");

  const { id } = await params;

  const [member, statuses, regLocations, regDepartments] = await Promise.all([
    prisma.member.findUnique({
      where: { id },
      include: {
        loans: {
          include: { resource: true },
          orderBy: [{ status: "asc" }, { borrowedAt: "desc" }],
        },
        reservations: {
          where: { status: { in: ["PENDING", "READY"] } },
          include: { resource: true },
          orderBy: [...HOLD_QUEUE_ORDER],
        },
      },
    }),
    prisma.memberStatus.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, canBorrow: true, isDefault: true },
    }),
    prisma.memberLocation.findMany({ orderBy: { name: "asc" }, select: { name: true } }),
    prisma.memberDepartment.findMany({ orderBy: { name: "asc" }, select: { name: true } }),
  ]);

  if (!member) notFound();
  const statusRow = statuses.find((s) => s.name === member.status);

  const activeLoans = member.loans.filter((l) => l.status === "ACTIVE");
  const pastLoans = member.loans
    .filter((l) => l.status === "RETURNED")
    .sort((a, b) => (b.returnedAt?.getTime() ?? 0) - (a.returnedAt?.getTime() ?? 0));
  const outstandingFines = pastLoans
    .filter((l) => l.fineCents > 0 && !l.finePaidAt && !l.fineWaivedAt)
    .reduce((n, l) => n + l.fineCents, 0);

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/admin/members" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back to members
      </Link>

      <div className="mb-6 mt-3 flex items-center gap-4">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-lg font-semibold text-primary">
          {initials(member.name)}
        </span>
        <div>
          <h1 className="font-display text-3xl font-semibold">{member.name}</h1>
          <p className="text-muted-foreground">{member.email}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {[member.phone, member.department, member.location, member.language]
              .filter(Boolean)
              .join(" · ") || "No contact details on file"}
          </p>
        </div>
        <div className="ml-auto flex flex-col items-end gap-1.5">
          <Badge tone="neutral">{MEMBER_TYPE_LABELS[member.memberType]}</Badge>
          {statusRow?.canBorrow === false ? (
            <Badge tone="danger">✕ {member.status}</Badge>
          ) : (
            <Badge tone="success">✓ {member.status}</Badge>
          )}
        </div>
      </div>

      <div className="mb-6 grid grid-cols-3 gap-3">
        <Card className="p-4 text-center">
          <p className="font-display text-2xl font-semibold">{activeLoans.length}<span className="text-base text-muted-foreground">/{member.maxLoans}</span></p>
          <p className="text-xs text-muted-foreground">Active loans</p>
        </Card>
        <Card className="p-4 text-center">
          <p className="font-display text-2xl font-semibold">{member.reservations.length}</p>
          <p className="text-xs text-muted-foreground">Active holds</p>
        </Card>
        <Card className="p-4 text-center">
          <p className="font-display text-2xl font-semibold">{pastLoans.length}</p>
          <p className="text-xs text-muted-foreground">Past loans</p>
        </Card>
      </div>

      {/* Active loans */}
      <Card className="mb-6 p-5">
        <h2 className="mb-3 font-display text-lg font-semibold">Active loans</h2>
        {activeLoans.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No items on loan.</p>
        ) : (
          <ul className="divide-y divide-border">
            {activeLoans.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{l.resource.title}</p>
                  <p className="text-xs text-muted-foreground">
                    Borrowed {formatDate(l.borrowedAt)} · {l.renewals} renewal{l.renewals === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={isOverdue(l.dueAt) ? "danger" : "muted"}>{dueLabel(l.dueAt)}</Badge>
                  <ActionButton action={renewLoan} fields={{ loanId: l.id }} variant="outline" className="!px-3 !py-1.5 text-xs" pendingLabel="…">Renew</ActionButton>
                  <ActionButton action={checkin} fields={{ loanId: l.id }} variant="primary" className="!px-3 !py-1.5 text-xs" pendingLabel="…">Return</ActionButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Holds */}
      {member.reservations.length > 0 && (
        <Card className="mb-6 p-5">
          <h2 className="mb-3 font-display text-lg font-semibold">Holds</h2>
          <ul className="divide-y divide-border">
            {member.reservations.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{r.resource.title}</p>
                  <p className="text-xs text-muted-foreground">Placed {formatDate(r.reservedAt)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={r.status === "READY" ? "accent" : "muted"}>{r.status === "READY" ? "Ready for pickup" : "Waiting"}</Badge>
                  <ActionButton action={cancelReservation} fields={{ reservationId: r.id }} variant="outline" className="!px-3 !py-1.5 text-xs" confirm="Cancel this hold?" pendingLabel="…">Cancel</ActionButton>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Past loans */}
      <Card className="mb-6 p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">Loan history</h2>
          <div className="flex items-center gap-2">
            {outstandingFines > 0 && (
              <Badge tone="accent">{formatFine(outstandingFines)} outstanding</Badge>
            )}
            <Link href={`/admin/loans/history?q=${encodeURIComponent(member.name)}`}
              className="text-xs text-primary hover:underline">
              Full history →
            </Link>
          </div>
        </div>
        {pastLoans.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No returned loans yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {pastLoans.slice(0, 15).map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{l.resource.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(l.borrowedAt)} → {formatDate(l.returnedAt)} · due {formatDate(l.dueAt)}
                    {l.renewals > 0 && ` · ${l.renewals} renewal${l.renewals === 1 ? "" : "s"}`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {l.returnStatus === "LATE" ? (
                    <Badge tone="danger">✕ Late</Badge>
                  ) : (
                    <Badge tone="success">✓ On time</Badge>
                  )}
                  {l.returnCondition && l.returnCondition !== "GOOD" && (
                    <Badge tone={l.returnCondition === "LOST" ? "danger" : "accent"}>
                      {l.returnCondition === "LOST" ? "✕ Lost" : "⚠ Damaged"}
                    </Badge>
                  )}
                  {l.fineCents > 0 && (
                    <Badge tone={l.finePaidAt ? "success" : l.fineWaivedAt ? "muted" : "accent"}>
                      {formatFine(l.fineCents)}
                      {l.finePaidAt ? " paid" : l.fineWaivedAt ? " waived" : " due"}
                    </Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {pastLoans.length > 15 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Showing the 15 most recent of {pastLoans.length} returned loans.
          </p>
        )}
      </Card>

      {/* Edit */}
      <Card className="p-5">
        <h2 className="mb-4 font-display text-lg font-semibold">Edit member</h2>
        <MemberForm
          action={updateMember}
          statuses={statuses}
          locations={regLocations.map((l) => l.name)}
          departments={regDepartments.map((d) => d.name)}
          defaults={{
            id: member.id,
            name: member.name,
            email: member.email,
            memberType: member.memberType,
            status: member.status,
            phone: member.phone ?? "",
            language: member.language,
            location: member.location ?? "",
            department: member.department ?? "",
            maxLoans: member.maxLoans,
          }}
          submitLabel="Save changes"
        />
      </Card>
    </div>
  );
}
