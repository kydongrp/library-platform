import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentMember } from "@/lib/session";
import { Card, EmptyState, ButtonLink, BookCover, Badge } from "@/components/ui";
import { RESOURCE_TYPE_LABELS } from "@/lib/constants";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const member = await getCurrentMember();
  if (!member) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-14">
        <EmptyState
          title="Sign in to see your browsing history"
          description="Titles you've viewed recently, so you can pick up where you left off."
          action={<ButtonLink href="/portal/signin">Sign in</ButtonLink>}
        />
      </div>
    );
  }

  const history = await prisma.browsingHistory.findMany({
    where: { memberId: member.id },
    include: { resource: true },
    orderBy: { viewedAt: "desc" },
    take: 50,
  });

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <h1 className="font-display text-3xl font-semibold">Browsing History</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        The last {history.length} title{history.length === 1 ? "" : "s"} you viewed.
      </p>

      {history.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            title="Nothing viewed yet"
            description="Open any title and it will appear here."
            action={<ButtonLink href="/portal">Browse the collection</ButtonLink>}
          />
        </div>
      ) : (
        <Card className="mt-6 divide-y divide-border overflow-hidden">
          {history.map((h) => (
            <Link
              key={h.id}
              href={`/portal/resource/${h.resourceId}`}
              className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50"
            >
              <BookCover title={h.resource.title} author={h.resource.author} color={h.resource.coverColor} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{h.resource.title}</p>
                <p className="truncate text-sm text-muted-foreground">{h.resource.author}</p>
              </div>
              <Badge tone="muted">{RESOURCE_TYPE_LABELS[h.resource.type] ?? h.resource.type}</Badge>
              <span className="shrink-0 text-xs text-muted-foreground">{formatDate(h.viewedAt)}</span>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}
