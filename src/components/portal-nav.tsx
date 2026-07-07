"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function PortalNav({
  items,
}: {
  items: { href: string; label: string; badge?: number }[];
}) {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1">
      {items.map((item) => {
        const active =
          item.href === "/portal"
            ? pathname === "/portal"
            : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`relative rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              active ? "bg-primary/10 text-primary" : "text-stone-600 hover:bg-muted"
            }`}
          >
            {item.label}
            {item.badge ? (
              <span className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                {item.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
