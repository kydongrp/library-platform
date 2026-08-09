import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentMember } from "@/lib/session";
import { Card, Badge, EmptyState, ButtonLink } from "@/components/ui";
import { signOut } from "@/app/actions/session";
import { MEMBER_TYPE_LABELS } from "@/lib/constants";
import { initials, formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const member = await getCurrentMember();
  if (!member) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-14">
        <EmptyState
          title="Sign in to see your profile"
          description="Your loans, holds, favourites, and settings live here."
          action={<ButtonLink href="/portal/signin">Sign in</ButtonLink>}
        />
      </div>
    );
  }

  const [loans, holds, favourites, reviews, unread] = await Promise.all([
    prisma.loan.count({ where: { memberId: member.id, status: "ACTIVE" } }),
    prisma.reservation.count({ where: { memberId: member.id, status: { in: ["PENDING", "READY"] } } }),
    prisma.favouriteItem.count({ where: { folder: { memberId: member.id } } }),
    prisma.review.count({ where: { memberId: member.id } }),
    prisma.notification.count({ where: { memberId: member.id, readAt: null } }),
  ]);

  const tiles = [
    { href: "/portal/my-loans", icon: "📚", label: "My Loans", meta: `${loans} active` },
    { href: "/portal/my-reservations", icon: "⏳", label: "My Reservations", meta: `${holds} active` },
    { href: "/portal/favourites", icon: "❤️", label: "My Favourites", meta: `${favourites} saved` },
    { href: "/portal/history", icon: "🕘", label: "Browsing History", meta: "recently viewed" },
    { href: "/portal/my-reviews", icon: "⭐", label: "My Reviews", meta: `${reviews} written` },
    { href: "/portal/requests", icon: "✍️", label: "Resource Requests", meta: "ask for new titles" },
    { href: "/portal/notifications", icon: "🔔", label: "Notification Centre", meta: unread ? `${unread} unread` : "all read" },
    { href: "/portal/preferences", icon: "🎯", label: "Preference Settings", meta: member.interests.length ? `${member.interests.length} areas of interest` : "set your interests" },
  ];

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <Card className="flex flex-wrap items-center gap-4 p-5">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/15 text-lg font-semibold text-accent">
          {initials(member.name)}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-semibold">{member.name}</h1>
          <p className="text-sm text-muted-foreground">{member.email}</p>
          <p className="mt-1 text-xs text-muted-foreground">Member since {formatDate(member.joinedAt)}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Badge tone="neutral">{MEMBER_TYPE_LABELS[member.memberType] ?? member.memberType}</Badge>
          <form action={signOut}>
            <button type="submit" className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
              Sign out
            </button>
          </form>
        </div>
      </Card>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {tiles.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-md"
          >
            <span className="text-2xl">{t.icon}</span>
            <span className="min-w-0">
              <span className="block font-medium">{t.label}</span>
              <span className="block truncate text-sm text-muted-foreground">{t.meta}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
