import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, Badge, BookCover, EmptyState, ButtonLink } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { renewLoan, checkin } from "@/app/actions/circulation";
import { getCurrentMember } from "@/lib/session";
import { isDigital } from "@/lib/availability";
import { formatDate, dueLabel, isOverdue } from "@/lib/format";

export default async function MyLoansPage() {
  const member = await getCurrentMember();
  if (!member) return <SignedOut />;

  const loans = await prisma.loan.findMany({
    where: { memberId: member.id },
    include: { resource: true },
    orderBy: [{ status: "asc" }, { borrowedAt: "desc" }],
  });

  const active = loans.filter((l) => l.status === "ACTIVE");
  const past = loans.filter((l) => l.status === "RETURNED");

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <h1 className="font-display text-3xl font-semibold">My Loans</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {active.length} active · {member.maxLoans} allowed
      </p>

      <h2 className="mb-3 mt-7 font-display text-xl font-semibold">Active</h2>
      {active.length === 0 ? (
        <EmptyState title="Nothing on loan" description="Borrow a title to see it here." action={<ButtonLink href="/portal">Browse the collection</ButtonLink>} />
      ) : (
        <div className="space-y-3">
          {active.map((l) => {
            const digital = isDigital(l.resource);
            return (
              <Card key={l.id} className="flex items-center gap-4 p-4">
                <Link href={`/portal/resource/${l.resourceId}`}>
                  <BookCover title={l.resource.title} author={l.resource.author} color={l.resource.coverColor} type={l.resource.type} size="sm" />
                </Link>
                <div className="min-w-0 flex-1">
                  <Link href={`/portal/resource/${l.resourceId}`} className="font-medium hover:underline">{l.resource.title}</Link>
                  <p className="text-sm text-muted-foreground">{l.resource.author}</p>
                  <div className="mt-1.5">
                    <Badge tone={isOverdue(l.dueAt) ? "danger" : digital ? "primary" : "muted"}>{dueLabel(l.dueAt)}</Badge>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <ActionButton action={renewLoan} fields={{ loanId: l.id }} variant="outline" className="!px-3 !py-1.5 text-xs" pendingLabel="…">Renew</ActionButton>
                  {digital && (
                    <ActionButton action={checkin} fields={{ loanId: l.id }} variant="ghost" className="!px-3 !py-1.5 text-xs" pendingLabel="…">Return</ActionButton>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {past.length > 0 && (
        <>
          <h2 className="mb-3 mt-9 font-display text-xl font-semibold">History</h2>
          <Card className="divide-y divide-border overflow-hidden">
            {past.map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <Link href={`/portal/resource/${l.resourceId}`} className="truncate font-medium hover:underline">{l.resource.title}</Link>
                  <p className="truncate text-sm text-muted-foreground">{l.resource.author}</p>
                </div>
                <Badge tone="muted">Returned {formatDate(l.returnedAt)}</Badge>
              </div>
            ))}
          </Card>
        </>
      )}
    </div>
  );
}

function SignedOut() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-14">
      <EmptyState
        title="Sign in to see your loans"
        description="Choose an account to view and manage your borrowed titles."
        action={<ButtonLink href="/portal/signin">Sign in</ButtonLink>}
      />
    </div>
  );
}
