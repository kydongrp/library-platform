import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { runEodProcess } from "@/app/actions/batch";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function BatchPage() {
  const admin = await requireAdminView("BATCH");
  const editable = canEdit(admin, "BATCH");

  const [runs, outbox, notifications] = await Promise.all([
    prisma.batchRun.findMany({ orderBy: { ranAt: "desc" }, take: 10 }),
    prisma.mailQueue.findMany({ orderBy: { createdAt: "desc" }, take: 15 }),
    prisma.notification.findMany({
      orderBy: { createdAt: "desc" },
      take: 15,
      include: { member: true },
    }),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Batch Processes</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The end-of-day process generates templated notices: due-soon and
            overdue reminders, expiry of uncollected holds, welcome and
            inactive-member nudges. In production this runs on a schedule; here
            you can trigger it on demand.
          </p>
        </div>
        {editable && (
          <ActionButton action={runEodProcess} fields={{}} pendingLabel="Running…">
            ▶ Run EodProcess now
          </ActionButton>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Run history */}
        <Card className="p-5">
          <h2 className="mb-3 font-display text-lg font-semibold">Run history</h2>
          {runs.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Never run. Trigger it to generate notifications from current data.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {runs.map((r) => (
                <li key={r.id} className="py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">{formatDate(r.ranAt)} · {r.ranAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</p>
                    <Badge tone="muted">{r.ranBy}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{r.summary}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Mail outbox */}
        <Card className="p-5">
          <h2 className="mb-3 font-display text-lg font-semibold">Mail outbox</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Emails the system would send (no SMTP is wired in this prototype).
          </p>
          {outbox.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No emails generated yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {outbox.map((m) => (
                <li key={m.id} className="py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 truncate text-sm font-medium">{m.subject}</p>
                    <Badge tone="primary">{m.template}</Badge>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    To {m.toName} &lt;{m.toEmail}&gt; · {formatDate(m.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* In-app notifications feed */}
      <Card className="mt-6 p-5">
        <h2 className="mb-3 font-display text-lg font-semibold">Recent in-app notifications</h2>
        {notifications.length === 0 ? (
          <EmptyState title="No notifications yet" description="Borrow, return, or run the EodProcess to generate some." />
        ) : (
          <ul className="divide-y divide-border">
            {notifications.map((n) => (
              <li key={n.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{n.title}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {n.member.name} · {formatDate(n.createdAt)}
                  </p>
                </div>
                <Badge tone="muted">{n.type}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
