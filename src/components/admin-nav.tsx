"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = { href: string; label: string; icon: string };

// Fixed-size pending hint (per Next docs: always rendered, opacity-toggled,
// so the row never shifts). Must live inside the <Link> to read its status.
function PendingSpinner() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      className={`ml-auto h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent transition-opacity duration-150 ${
        pending ? "opacity-60" : "opacity-0"
      }`}
    />
  );
}

export function AdminNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
        const active =
          item.href === "/admin"
            ? pathname === "/admin"
            : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-stone-600 hover:bg-muted hover:text-foreground"
            }`}
          >
            <span className="text-base leading-none">{item.icon}</span>
            {item.label}
            <PendingSpinner />
          </Link>
        );
      })}
    </nav>
  );
}
