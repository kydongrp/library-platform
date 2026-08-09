import { requireAdminView } from "@/lib/admin-guard";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { checkin, renewLoan } from "@/app/actions/circulation";
import { formatDate, dueLabel, isOverdue } from "@/lib/format";

type SearchParams = Promise<{ filter?: string }>;

export default async function LoansPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireAdminView("LOANS");

  const { filter = "all" } = await searchParams;
  const now = new Date();

  const where =
    filter === "overdue"
      ? { status: "ACTIVE", dueAt: { lt: now } }
      : { status: "ACTIVE" };

  const loans = await prisma.loan.findMany({
    where,
    include: { member: true, resource: true, copy: true },
    orderBy: { dueAt: "asc" },
  });

  const tabs = [
    { key: "all", label: "All active" },
    { key: "overdue", label: "Overdue only" },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-5">
        <h1 className="font-display text-3xl font-semibold">Current Loans</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {loans.length} active loan{loans.length === 1 ? "" : "s"}.
        </p>
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
          title={filter === "overdue" ? "Nothing overdue" : "No active loans"}
          description={filter === "overdue" ? "Every loan is within its due date." : "Check something out at the Circulation Desk."}
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
              </div>
              <Badge tone={isOverdue(l.dueAt) ? "danger" : "muted"}>{dueLabel(l.dueAt)}</Badge>
              <div className="flex items-center gap-2">
                <ActionButton action={renewLoan} fields={{ loanId: l.id }} variant="outline" className="!px-3 !py-1.5 text-xs" pendingLabel="…">Renew</ActionButton>
                <ActionButton action={checkin} fields={{ loanId: l.id }} variant="primary" className="!px-3 !py-1.5 text-xs" pendingLabel="…">Return</ActionButton>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
