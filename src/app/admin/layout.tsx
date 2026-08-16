import Link from "next/link";
import { ToastProvider } from "@/components/toast";
import { AdminNav, type NavItem } from "@/components/admin-nav";
import { getCurrentAdmin, canView } from "@/lib/admin-session";
import { signOutAdmin } from "@/app/actions/admin-settings";
import { initials } from "@/lib/format";

const NAV: (NavItem & { area: string })[] = [
  { href: "/admin", label: "Dashboard", icon: "▣", area: "DASHBOARD" },
  { href: "/admin/circulation", label: "Circulation Desk", icon: "⇄", area: "CIRCULATION" },
  { href: "/admin/catalogue", label: "Catalogue", icon: "▤", area: "CATALOGUE" },
  { href: "/admin/editors-pick", label: "Editor's Picks", icon: "★", area: "CATALOGUE" },
  { href: "/admin/members", label: "Members", icon: "◎", area: "MEMBERS" },
  { href: "/admin/loans", label: "Current Loans", icon: "↻", area: "LOANS" },
  { href: "/admin/reservations", label: "Reservations", icon: "✦", area: "RESERVATIONS" },
  { href: "/admin/requests", label: "Resource Requests", icon: "✍", area: "REQUESTS" },
  { href: "/admin/policies", label: "Loan Policies", icon: "§", area: "POLICIES" },
  { href: "/admin/templates", label: "Email Templates", icon: "✉", area: "TEMPLATES" },
  { href: "/admin/reports", label: "Reports", icon: "▥", area: "REPORTS" },
  { href: "/admin/batch", label: "Batch Processes", icon: "⏱", area: "BATCH" },
  { href: "/admin/access-health", label: "Access Health", icon: "✚", area: "BATCH" },
  { href: "/admin/audit", label: "Audit Trail", icon: "≣", area: "ADMIN" },
  { href: "/admin/settings", label: "Admin Settings", icon: "⚙", area: "ADMIN" },
];

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await getCurrentAdmin();
  const items = admin ? NAV.filter((n) => canView(admin, n.area)) : [];

  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-1">
        {/* Sidebar */}
        <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card/60 px-4 py-6 md:flex">
          <Link href="/admin" className="mb-6 flex items-center gap-2 px-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary font-display text-lg font-bold text-primary-foreground">
              D
            </span>
            <div>
              <p className="font-display text-lg font-semibold leading-none">
                DLS Admin
              </p>
              <p className="text-xs text-muted-foreground">Digital Library System</p>
            </div>
          </Link>

          {admin ? (
            <>
              <div className="mb-5 flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">
                  {initials(admin.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium leading-tight">{admin.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{admin.groupName}</p>
                </div>
                <form action={signOutAdmin}>
                  <button
                    type="submit"
                    title="Sign out"
                    className="rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    ⎋
                  </button>
                </form>
              </div>
              <AdminNav items={items} />
            </>
          ) : (
            <Link
              href="/admin/signin"
              className="rounded-lg bg-primary px-3 py-2 text-center text-sm font-medium text-primary-foreground hover:bg-primary-hover"
            >
              Staff sign-in
            </Link>
          )}

          <div className="mt-auto pt-6">
            <Link
              href="/"
              className="block rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              ← Back to home
            </Link>
          </div>
        </aside>

        {/* Main */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Mobile top nav */}
          <header className="flex items-center gap-3 border-b border-border bg-card px-4 py-3 md:hidden">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
              D
            </span>
            <span className="font-display font-semibold">DLS Admin</span>
            <Link href="/" className="ml-auto text-sm text-muted-foreground">
              Home
            </Link>
          </header>
          <main className="flex-1 px-5 py-7 md:px-9">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}
