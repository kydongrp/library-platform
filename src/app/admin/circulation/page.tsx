import { requireAdminView } from "@/lib/admin-guard";
import { prisma } from "@/lib/db";
import { Card, Badge } from "@/components/ui";
import { CirculationDesk } from "./desk";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function CirculationPage() {
  await requireAdminView("CIRCULATION");

  // Every member is listed — statuses that block borrowing are labelled in
  // the picker rather than hidden, so staff can see why a checkout is refused.
  const [borrowable, allMembers, recent, availableSample] = await Promise.all([
    prisma.memberStatus.findMany({ where: { canBorrow: true }, select: { name: true } }),
    prisma.member.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, memberType: true, status: true },
    }),
    prisma.loan.findMany({
      orderBy: { borrowedAt: "desc" },
      take: 8,
      include: { member: true, resource: true, copy: true },
    }),
    // A few available barcodes to make the demo easy to drive.
    prisma.copy.findMany({
      where: { status: "AVAILABLE" },
      take: 5,
      include: { resource: true },
      orderBy: { barcode: "asc" },
    }),
  ]);

  const canBorrow = new Set(borrowable.map((s) => s.name));
  const members = allMembers.map((m) => ({
    id: m.id,
    name: canBorrow.has(m.status) ? m.name : `${m.name} — ${m.status} (cannot borrow)`,
    memberType: m.memberType,
  }));

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Circulation Desk</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Check items out and in. Loan periods are set automatically by member type.
        </p>
      </div>

      <CirculationDesk members={members} />

      {availableSample.length > 0 && (
        <Card className="mt-6 p-5">
          <h2 className="mb-2 font-display text-base font-semibold">Available barcodes (demo helper)</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Copy one of these into the check-out box to try it.
          </p>
          <div className="flex flex-wrap gap-2">
            {availableSample.map((c) => (
              <span key={c.id} className="rounded-md border border-border bg-muted px-2.5 py-1 font-mono text-xs">
                {c.barcode}
                <span className="ml-2 font-sans text-muted-foreground">{c.resource.title}</span>
              </span>
            ))}
          </div>
        </Card>
      )}

      <Card className="mt-6 p-5">
        <h2 className="mb-3 font-display text-lg font-semibold">Recent transactions</h2>
        <ul className="divide-y divide-border">
          {recent.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{l.resource.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {l.member.name}
                  {l.copy ? ` · ${l.copy.barcode}` : " · digital"} · {formatDate(l.borrowedAt)}
                </p>
              </div>
              <Badge tone={l.status === "ACTIVE" ? "primary" : "muted"}>
                {l.status === "ACTIVE" ? "Out" : `Returned ${formatDate(l.returnedAt)}`}
              </Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
