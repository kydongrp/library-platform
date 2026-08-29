import Link from "next/link";
import { ToastProvider } from "@/components/toast";
import { AdminNav, type NavItem, type NavGroup } from "@/components/admin-nav";
import { getCurrentAdmin, canView } from "@/lib/admin-session";
import { signOutAdmin } from "@/app/actions/admin-settings";
import { initials } from "@/lib/format";

type Entry = NavItem & { area: string };

/**
 * The sidebar, grouped.
 *
 * Twenty-four destinations in one flat list was longer than a laptop screen and
 * gave no clue which module a page belonged to. The grouping is the way a
 * library is organised rather than the way the code is, and it is deliberately
 * aligned with the permission areas: every item in a group shares an area, or
 * shares one with its neighbours, so a restricted account sees whole sections
 * rather than orphaned single links.
 *
 * Dashboard sits outside the groups because it is the landing page.
 */
const TOP: Entry[] = [
  { href: "/admin", label: "Dashboard", icon: "▣", area: "DASHBOARD" },
];

const GROUPS: (Omit<NavGroup, "items"> & { items: Entry[] })[] = [
  {
    label: "Circulation",
    items: [
      { href: "/admin/circulation", label: "Circulation Desk", icon: "⇄", area: "CIRCULATION" },
      { href: "/admin/loans", label: "Current Loans", icon: "↻", area: "LOANS" },
      { href: "/admin/reservations", label: "Holds & Bookings", icon: "✦", area: "RESERVATIONS" },
    ],
  },
  {
    label: "Catalogue",
    items: [
      { href: "/admin/catalogue", label: "Catalogue", icon: "▤", area: "CATALOGUE" },
      { href: "/admin/items", label: "Items", icon: "▪", area: "CATALOGUE" },
      { href: "/admin/cataloguing", label: "MARC & Authorities", icon: "❐", area: "CATALOGUE" },
      { href: "/admin/editors-pick", label: "Editor's Picks", icon: "★", area: "CATALOGUE" },
    ],
  },
  {
    label: "Collections",
    items: [
      { href: "/admin/acquisitions", label: "Acquisitions", icon: "¤", area: "CATALOGUE" },
      { href: "/admin/serials", label: "Serials", icon: "◫", area: "CATALOGUE" },
      { href: "/admin/eresources", label: "Subscriptions", icon: "◈", area: "CATALOGUE" },
      { href: "/admin/access-health", label: "Access Health", icon: "✚", area: "BATCH" },
    ],
  },
  {
    label: "Members",
    items: [
      { href: "/admin/members", label: "Members", icon: "◎", area: "MEMBERS" },
      { href: "/admin/requests", label: "Resource Requests", icon: "✍", area: "REQUESTS" },
    ],
  },
  {
    label: "Reports",
    items: [
      { href: "/admin/reports", label: "Reports", icon: "▥", area: "REPORTS" },
      { href: "/admin/reports/flexi", label: "FlexiReports", icon: "⊞", area: "REPORTS" },
      {
        href: "/admin/dashboards/catalogue",
        // Links to the first dashboard, but stays highlighted on all six.
        match: "/admin/dashboards",
        label: "Module Dashboards",
        icon: "◧",
        area: "REPORTS",
      },
    ],
  },
  {
    label: "Configuration",
    items: [
      { href: "/admin/users", label: "Admin Accounts", icon: "◘", area: "ADMIN" },
      { href: "/admin/policies", label: "Loan Policies", icon: "§", area: "POLICIES" },
      { href: "/admin/calendar", label: "Library Calendar", icon: "▦", area: "POLICIES" },
      { href: "/admin/templates", label: "Email Templates", icon: "✉", area: "TEMPLATES" },
      { href: "/admin/batch", label: "Batch Processes", icon: "⏱", area: "BATCH" },
      { href: "/admin/portal-api", label: "Portal API", icon: "⇌", area: "ADMIN" },
      { href: "/admin/audit", label: "Audit Trail", icon: "≣", area: "ADMIN" },
      { href: "/admin/settings", label: "Admin Settings", icon: "⚙", area: "ADMIN" },
    ],
  },
];

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await getCurrentAdmin();
  const visible = (list: Entry[]) => (admin ? list.filter((n) => canView(admin, n.area)) : []);
  const top = visible(TOP);
  // Drop a group entirely when this account can see none of it, rather than
  // leaving an empty heading.
  const groups = GROUPS.map((g) => ({ label: g.label, items: visible(g.items) })).filter(
    (g) => g.items.length > 0,
  );

  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-1">
        {/* Sidebar */}
        <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card/60 px-4 py-6 md:sticky md:top-0 md:flex md:h-screen md:overflow-y-auto">
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
              <AdminNav top={top} groups={groups} />
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
