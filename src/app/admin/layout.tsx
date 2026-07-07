import Link from "next/link";
import { ToastProvider } from "@/components/toast";
import { AdminNav, type NavItem } from "@/components/admin-nav";

const NAV: NavItem[] = [
  { href: "/admin", label: "Dashboard", icon: "▣" },
  { href: "/admin/circulation", label: "Circulation Desk", icon: "⇄" },
  { href: "/admin/catalogue", label: "Catalogue", icon: "▤" },
  { href: "/admin/members", label: "Members", icon: "◎" },
  { href: "/admin/loans", label: "Current Loans", icon: "↻" },
  { href: "/admin/reservations", label: "Reservations", icon: "✦" },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-1">
        {/* Sidebar */}
        <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card/60 px-4 py-6 md:flex">
          <Link href="/admin" className="mb-8 flex items-center gap-2 px-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary font-display text-lg font-bold text-primary-foreground">
              A
            </span>
            <div>
              <p className="font-display text-lg font-semibold leading-none">
                Athenaeum
              </p>
              <p className="text-xs text-muted-foreground">Admin Panel</p>
            </div>
          </Link>
          <AdminNav items={NAV} />
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
              A
            </span>
            <span className="font-display font-semibold">Admin Panel</span>
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
