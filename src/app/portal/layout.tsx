import Link from "next/link";
import { prisma } from "@/lib/db";
import { ToastProvider } from "@/components/toast";
import { PortalSearch } from "@/components/portal-search";
import { PortalNav } from "@/components/portal-nav";
import { getCurrentMember } from "@/lib/session";
import { signOut } from "@/app/actions/session";
import { initials } from "@/lib/format";

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const member = await getCurrentMember();

  let loanCount = 0;
  let holdCount = 0;
  if (member) {
    [loanCount, holdCount] = await Promise.all([
      prisma.loan.count({ where: { memberId: member.id, status: "ACTIVE" } }),
      prisma.reservation.count({
        where: { memberId: member.id, status: { in: ["PENDING", "READY"] } },
      }),
    ]);
  }

  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-4 px-5 py-3">
            <Link href="/portal" className="flex shrink-0 items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary font-display text-lg font-bold text-primary-foreground">
                A
              </span>
              <span className="hidden font-display text-lg font-semibold sm:block">
                Athenaeum
              </span>
            </Link>

            <div className="hidden max-w-md flex-1 md:block">
              <PortalSearch />
            </div>

            <div className="ml-auto flex items-center gap-2">
              <PortalNav
                items={[
                  { href: "/portal", label: "Browse" },
                  { href: "/portal/my-loans", label: "My Loans", badge: loanCount },
                  { href: "/portal/my-reservations", label: "Holds", badge: holdCount },
                ]}
              />
              {member ? (
                <form action={signOut} className="flex items-center gap-2 pl-1">
                  <span
                    title={member.name}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/15 text-sm font-semibold text-accent"
                  >
                    {initials(member.name)}
                  </span>
                  <button
                    type="submit"
                    className="hidden rounded-full px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted sm:block"
                  >
                    Sign out
                  </button>
                </form>
              ) : (
                <Link
                  href="/portal/signin"
                  className="rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
                >
                  Sign in
                </Link>
              )}
            </div>
          </div>
          {/* Mobile search */}
          <div className="px-5 pb-3 md:hidden">
            <PortalSearch />
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-border bg-card/50">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 text-sm text-muted-foreground">
            <span>Athenaeum Learner Portal</span>
            <Link href="/admin" className="hover:text-foreground">
              Staff? Open the Admin Panel →
            </Link>
          </div>
        </footer>
      </div>
    </ToastProvider>
  );
}
