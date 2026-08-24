"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

export type NavItem = {
  href: string;
  label: string;
  icon: string;
  /** Prefix that counts as "you are here", when it differs from href. */
  match?: string;
};

export type NavGroup = { label: string; items: NavItem[] };

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

/**
 * Which single item is "here".
 *
 * Longest match wins, so /admin/reports/flexi highlights FlexiReports alone
 * instead of lighting up Reports as well, which the old flat prefix test did.
 * /admin is compared exactly, or it would match every page.
 */
function activeHref(items: NavItem[], pathname: string): string | null {
  let best: string | null = null;
  let bestLength = -1;
  for (const item of items) {
    const prefix = item.match ?? item.href;
    const hit = prefix === "/admin" ? pathname === "/admin" : pathname.startsWith(prefix);
    if (hit && prefix.length > bestLength) {
      best = item.href;
      bestLength = prefix.length;
    }
  }
  return best;
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
        active
          ? "bg-primary font-medium text-primary-foreground shadow-sm"
          : "text-stone-600 hover:bg-muted hover:text-foreground"
      }`}
    >
      <span className="w-4 shrink-0 text-center text-base leading-none">{item.icon}</span>
      <span className="truncate">{item.label}</span>
      <PendingSpinner />
    </Link>
  );
}

export function AdminNav({ top, groups }: { top: NavItem[]; groups: NavGroup[] }) {
  const pathname = usePathname();
  const here = activeHref([...top, ...groups.flatMap((g) => g.items)], pathname);
  const currentGroup = groups.find((g) => g.items.some((i) => i.href === here))?.label ?? null;

  /**
   * Sections open themselves when you are inside them; `toggled` records only
   * the ones you have opened or closed by hand, so it stays an override rather
   * than a second source of truth.
   *
   * This component lives in the layout, so the overrides survive navigation
   * within the app and reset on a full reload, which is the behaviour worth
   * having without reaching for storage.
   */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [seenGroup, setSeenGroup] = useState(currentGroup);

  // Arriving in a section clears any manual collapse on it, so following a link
  // never lands you on a page whose own section is shut. Adjusting state during
  // render is the documented way to react to a changed input without an effect.
  if (seenGroup !== currentGroup) {
    setSeenGroup(currentGroup);
    if (currentGroup && currentGroup in toggled) {
      setToggled((prev) => {
        const next = { ...prev };
        delete next[currentGroup];
        return next;
      });
    }
  }

  return (
    <nav className="flex flex-col gap-1" aria-label="Admin sections">
      {top.map((item) => (
        <NavLink key={item.href} item={item} active={here === item.href} />
      ))}

      {groups.map((group) => {
        const id = `nav-${group.label.toLowerCase().replace(/\s+/g, "-")}`;
        const holdsActive = group.label === currentGroup;
        const isOpen = toggled[group.label] ?? holdsActive;
        return (
          <div key={group.label} className="mt-1.5">
            <button
              type="button"
              onClick={() => setToggled((prev) => ({ ...prev, [group.label]: !isOpen }))}
              aria-expanded={isOpen}
              aria-controls={id}
              className="flex w-full items-center gap-1.5 rounded-md px-3 py-1 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span
                aria-hidden
                className={`text-[9px] leading-none transition-transform duration-150 motion-reduce:transition-none ${
                  isOpen ? "rotate-90" : ""
                }`}
              >
                ▶
              </span>
              <span>{group.label}</span>
              {/* Collapsed, a dot marks the section you are in and a count says
                  how much is inside, so a shut sidebar still orients you. */}
              {isOpen ? null : holdsActive ? (
                <span
                  className="ml-auto h-1.5 w-1.5 rounded-full bg-primary"
                  title="You are in this section"
                />
              ) : (
                <span className="ml-auto text-[10px] font-normal tabular-nums tracking-normal opacity-60">
                  {group.items.length}
                </span>
              )}
            </button>
            <div id={id} hidden={!isOpen} className="mt-0.5 flex flex-col gap-0.5">
              {group.items.map((item) => (
                <NavLink key={item.href} item={item} active={here === item.href} />
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );
}
