import { prisma } from "@/lib/db";
import { getCurrentMember } from "@/lib/session";
import { Card, Badge, EmptyState, ButtonLink } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { markNotificationRead } from "@/app/actions/engagement";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const TYPE_TONE: Record<string, "primary" | "danger" | "accent" | "muted" | "success"> = {
  OVERDUE: "danger",
  PREDUE: "accent",
  RESERVATION_READY: "accent",
  DIGITAL_AVAILABLE: "success",
  RECALL: "danger",
  BORROW: "primary",
  RETURN: "muted",
  WELCOME: "primary",
  REQUEST_UPDATE: "primary",
};

export default async function NotificationsPage() {
  const member = await getCurrentMember();
  if (!member) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-14">
        <EmptyState
          title="Sign in to see your notifications"
          description="Borrow/return confirmations, due-date reminders, and hold updates land here."
          action={<ButtonLink href="/portal/signin">Sign in</ButtonLink>}
        />
      </div>
    );
  }

  const notifications = await prisma.notification.findMany({
    where: { memberId: member.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const unread = notifications.filter((n) => !n.readAt).length;

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-semibold">Notification Centre</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {unread > 0 ? `${unread} unread` : "You're all caught up."}
          </p>
        </div>
        {unread > 0 && (
          <ActionButton action={markNotificationRead} fields={{ all: "1" }} variant="outline" className="!px-3 !py-1.5 text-xs" pendingLabel="…">
            Mark all read
          </ActionButton>
        )}
      </div>

      {notifications.length === 0 ? (
        <div className="mt-8">
          <EmptyState title="Nothing yet" description="Notifications appear when you borrow, return, or a hold becomes available." />
        </div>
      ) : (
        <Card className="mt-6 divide-y divide-border overflow-hidden">
          {notifications.map((n) => (
            <div
              key={n.id}
              className={`flex flex-wrap items-start gap-3 px-4 py-3 ${n.readAt ? "opacity-70" : "bg-primary/[0.03]"}`}
            >
              {!n.readAt && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="unread" />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{n.title}</p>
                <p className="mt-0.5 whitespace-pre-line text-sm text-muted-foreground">{n.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">{formatDate(n.createdAt)}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <Badge tone={TYPE_TONE[n.type] ?? "muted"}>{n.type.replaceAll("_", " ").toLowerCase()}</Badge>
                {!n.readAt && (
                  <ActionButton action={markNotificationRead} fields={{ notificationId: n.id }} variant="ghost" className="!px-2 !py-1 text-xs" pendingLabel="…">
                    Mark read
                  </ActionButton>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
