import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { RequestRow } from "./row";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AdminRequestsPage() {
  const admin = await requireAdminView("REQUESTS");
  const editable = canEdit(admin, "REQUESTS");

  const requests = await prisma.resourceRequest.findMany({
    include: { member: true },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });

  const pending = requests.filter((r) => r.status === "PENDING");
  const decided = requests.filter((r) => r.status !== "PENDING");

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Resource Requests</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Learner requests for titles the library doesn&apos;t hold. Decisions
          notify the requester automatically.
        </p>
      </div>

      <h2 className="mb-2 font-display text-lg font-semibold">
        Awaiting review {pending.length > 0 && <Badge tone="accent">{pending.length}</Badge>}
      </h2>
      {pending.length === 0 ? (
        <EmptyState title="Nothing waiting" description="New learner requests will appear here." />
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {pending.map((r) => (
            <RequestRow
              key={r.id}
              request={{
                id: r.id, title: r.title, author: r.author, details: r.details,
                status: r.status, staffNote: r.staffNote,
                memberName: r.member.name, createdAt: formatDate(r.createdAt),
              }}
              readOnly={!editable}
            />
          ))}
        </Card>
      )}

      {decided.length > 0 && (
        <>
          <h2 className="mb-2 mt-8 font-display text-lg font-semibold">Decided</h2>
          <Card className="divide-y divide-border overflow-hidden">
            {decided.map((r) => (
              <RequestRow
                key={r.id}
                request={{
                  id: r.id, title: r.title, author: r.author, details: r.details,
                  status: r.status, staffNote: r.staffNote,
                  memberName: r.member.name, createdAt: formatDate(r.createdAt),
                }}
                readOnly={!editable}
              />
            ))}
          </Card>
        </>
      )}
    </div>
  );
}
