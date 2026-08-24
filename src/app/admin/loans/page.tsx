import { requireAdminView } from "@/lib/admin-guard";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState, ButtonLink } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { checkin, renewLoan, recallLoan } from "@/app/actions/circulation";
import { ClaimReturnButton, WithdrawClaimButton, WriteOffClaimButton } from "./claim-widgets";
import { dueLabel, formatDate, formatTime, isOverdue } from "@/lib/format";
import { getAccruingFines } from "@/lib/loan-history";
import { formatFine } from "@/lib/fines";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ filter?: string }>;

export default async function LoansPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireAdminView("LOANS");

  const { filter = "all" } = await searchParams;
  const now = new Date();

  // Row 51 adds a claims worklist and row 56 an hourly view; both are
  // filters over active loans rather than separate pages, because that is
  // what they are.
  const where: Record<string, unknown> =
    filter === "overdue"
      ? { status: "ACTIVE", dueAt: { lt: now }, claimedReturnedAt: null }
      : filter === "claims"
        ? { status: "ACTIVE", claimedReturnedAt: { not: null } }
        : filter === "hourly"
          ? { status: "ACTIVE", copy: { itemType: { loanHours: { not: null } } } }
          : { status: "ACTIVE" };

  const [loans, accruing] = await Promise.all([
    prisma.loan.findMany({
      where,
      include: {
        member: true,
        resource: true,
        copy: { include: { itemType: true } },
      },
      orderBy: { dueAt: "asc" },
    }),
    // Live figures: nothing is charged until the item is checked in.
    getAccruingFines(now),
  ]);
  const accruedByLoan = new Map(accruing.map((a) => [a.loanId, a]));
  const accruedTotal = accruing.reduce((n, a) => n + a.accruedCents, 0);

  const [claimCount, hourlyCount] = await Promise.all([
    prisma.loan.count({ where: { status: "ACTIVE", claimedReturnedAt: { not: null } } }),
    prisma.loan.count({
      where: { status: "ACTIVE", copy: { itemType: { loanHours: { not: null } } } },
    }),
  ]);

  const tabs = [
    { key: "all", label: "All active" },
    { key: "overdue", label: "Overdue only" },
    { key: "hourly", label: hourlyCount > 0 ? `Hourly (${hourlyCount})` : "Hourly" },
    { key: "claims", label: claimCount > 0 ? `Claimed returns (${claimCount})` : "Claimed returns" },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-semibold">Current Loans</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {loans.length} active loan{loans.length === 1 ? "" : "s"}
            {accruing.length > 0 && (
              <>
                {" · "}
                <span className="font-medium text-amber-700">
                  {formatFine(accruedTotal)} accruing across {accruing.length} overdue
                </span>
              </>
            )}
            .
          </p>
        </div>
        <ButtonLink href="/admin/loans/history" variant="outline">≣ Loan history</ButtonLink>
      </div>

      <div className="mb-5 flex gap-2">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/admin/loans?filter=${t.key}`}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              filter === t.key
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {loans.length === 0 ? (
        <EmptyState
          title={
            filter === "overdue"
              ? "Nothing overdue"
              : filter === "claims"
                ? "No open claims"
                : filter === "hourly"
                  ? "No hourly loans out"
                  : "No active loans"
          }
          description={
            filter === "overdue"
              ? "Every loan is within its due date."
              : filter === "claims"
                ? "Nobody is disputing a return. Claims are raised from the All active tab."
                : filter === "hourly"
                  ? "Give an item type an hourly loan period under Items to circulate equipment by the hour."
                  : "Check something out at the Circulation Desk."
          }
        />
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {loans.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{l.resource.title}</p>
                <p className="truncate text-sm text-muted-foreground">
                  <Link href={`/admin/members/${l.memberId}`} className="hover:underline">{l.member.name}</Link>
                  {l.copy ? ` · ${l.copy.barcode}` : " · digital"} · borrowed {formatDate(l.borrowedAt)}
                </p>
                {l.claimedReturnedAt && (
                  <p className="truncate text-xs text-amber-700">
                    Fines frozen since {formatDate(l.claimedReturnedAt)}
                    {l.claimedReturnBy ? ` · recorded by ${l.claimedReturnBy}` : ""}
                    {l.claimedReturnNote ? ` · ${l.claimedReturnNote}` : ""}
                  </p>
                )}
              </div>
              {l.recalledAt && <Badge tone="accent">Recalled</Badge>}
              {l.copy?.itemType?.loanHours && (
                <Badge tone="neutral">{l.copy.itemType.loanHours}h loan</Badge>
              )}
              {/* An hourly loan is due at a time of day, so a date alone is
                  useless. Show the clock, and compare instants for lateness. */}
              {l.copy?.itemType?.loanHours ? (
                <Badge tone={l.dueAt.getTime() < now.getTime() ? "danger" : "muted"}>
                  {l.dueAt.getTime() < now.getTime() ? "overdue since " : "due "}
                  {formatTime(l.dueAt)}
                  {formatDate(l.dueAt) !== formatDate(now) ? ` ${formatDate(l.dueAt)}` : ""}
                </Badge>
              ) : (
                <Badge tone={isOverdue(l.dueAt) ? "danger" : "muted"}>{dueLabel(l.dueAt)}</Badge>
              )}
              {l.claimedReturnedAt && (
                <Badge tone="accent">claimed returned {formatDate(l.claimedReturnedAt)}</Badge>
              )}
              {(() => {
                const a = accruedByLoan.get(l.id);
                if (!a) return null;
                return a.accruedCents > 0 ? (
                  <Badge tone="accent">
                    {formatFine(a.accruedCents)} accruing · {a.daysLate} open day{a.daysLate === 1 ? "" : "s"}
                  </Badge>
                ) : (
                  <Badge tone="muted">no fine yet</Badge>
                );
              })()}
              <div className="flex flex-wrap items-center gap-2">
                {l.claimedReturnedAt ? (
                  <>
                    {/* Resolving a claim: it turns up (Found), the member
                        accepts they have it (Withdraw), or it is written off. */}
                    <ActionButton action={checkin} fields={{ loanId: l.id }} variant="primary" className="!px-3 !py-1.5 text-xs" pendingLabel="…">
                      Found: check in
                    </ActionButton>
                    <WithdrawClaimButton loanId={l.id} />
                    <WriteOffClaimButton loanId={l.id} title={l.resource.title} />
                  </>
                ) : (
                  <>
                    {!l.recalledAt && (
                      <ActionButton action={recallLoan} fields={{ loanId: l.id }} variant="outline" className="!px-3 !py-1.5 text-xs" confirm="Recall this loan? The member will be notified and the due date shortened." pendingLabel="…">Recall</ActionButton>
                    )}
                    <ActionButton action={renewLoan} fields={{ loanId: l.id }} variant="outline" className="!px-3 !py-1.5 text-xs" pendingLabel="…">Renew</ActionButton>
                    <ClaimReturnButton loanId={l.id} />
                    <ActionButton action={checkin} fields={{ loanId: l.id }} variant="primary" className="!px-3 !py-1.5 text-xs" pendingLabel="…">Return</ActionButton>
                  </>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
