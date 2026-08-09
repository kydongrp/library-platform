import { prisma } from "@/lib/db";
import { getCurrentMember } from "@/lib/session";
import { Card, Badge, EmptyState, ButtonLink } from "@/components/ui";
import { RequestForm, WithdrawButton } from "./form";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "muted" | "success" | "danger" | "primary"> = {
  PENDING: "muted",
  APPROVED: "success",
  REJECTED: "danger",
  ACQUIRED: "primary",
};

export default async function RequestsPage() {
  const member = await getCurrentMember();
  if (!member) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-14">
        <EmptyState
          title="Sign in to request resources"
          description="Ask the library to acquire titles that aren't in the collection or subscriptions yet."
          action={<ButtonLink href="/portal/signin">Sign in</ButtonLink>}
        />
      </div>
    );
  }

  const requests = await prisma.resourceRequest.findMany({
    where: { memberId: member.id },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <h1 className="font-display text-3xl font-semibold">Resource Requests</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Can&apos;t find something in the collection? Request it and the library team
        will review whether to acquire or subscribe to it.
      </p>

      <Card className="mt-6 p-5">
        <h2 className="mb-4 font-display text-lg font-semibold">New request</h2>
        <RequestForm />
      </Card>

      <h2 className="mb-3 mt-8 font-display text-xl font-semibold">My requests</h2>
      {requests.length === 0 ? (
        <EmptyState title="No requests yet" description="Your submitted requests and their status will appear here." />
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {requests.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{r.title}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {r.author ? `${r.author} · ` : ""}submitted {formatDate(r.createdAt)}
                </p>
                {r.staffNote && (
                  <p className="mt-1 text-xs text-muted-foreground">Library note: {r.staffNote}</p>
                )}
              </div>
              <Badge tone={STATUS_TONE[r.status] ?? "muted"}>{r.status.toLowerCase()}</Badge>
              {r.status === "PENDING" && <WithdrawButton requestId={r.id} />}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
