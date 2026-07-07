import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, Badge, ButtonLink, EmptyState } from "@/components/ui";
import { MEMBER_TYPE_LABELS } from "@/lib/constants";
import { initials, formatDate } from "@/lib/format";

type SearchParams = Promise<{ q?: string }>;

export default async function MembersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { q = "" } = await searchParams;

  const members = await prisma.member.findMany({
    where: q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
          ],
        }
      : undefined,
    include: { _count: { select: { loans: { where: { status: "ACTIVE" } } } } },
    orderBy: { name: "asc" },
  });

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Members</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {members.length} member{members.length === 1 ? "" : "s"}.
          </p>
        </div>
        <ButtonLink href="/admin/members/new">+ Add member</ButtonLink>
      </div>

      <form className="mb-6 flex gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search name or email…"
          className="min-w-56 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
        <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
          Search
        </button>
        {q && (
          <Link href="/admin/members" className="px-2 py-2 text-sm text-muted-foreground hover:text-foreground">
            Clear
          </Link>
        )}
      </form>

      {members.length === 0 ? (
        <EmptyState title="No members found" description="Add a member to get started." action={<ButtonLink href="/admin/members/new">+ Add member</ButtonLink>} />
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {members.map((m) => (
            <Link key={m.id} href={`/admin/members/${m.id}`} className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/50">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                {initials(m.name)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{m.name}</p>
                <p className="truncate text-sm text-muted-foreground">{m.email}</p>
              </div>
              <div className="hidden text-right text-xs text-muted-foreground sm:block">
                Joined {formatDate(m.joinedAt)}
              </div>
              <Badge tone="neutral">{MEMBER_TYPE_LABELS[m.memberType]}</Badge>
              {m.status === "SUSPENDED" ? (
                <Badge tone="danger">Suspended</Badge>
              ) : (
                <Badge tone="primary">{m._count.loans} on loan</Badge>
              )}
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}
