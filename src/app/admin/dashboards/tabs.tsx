import Link from "next/link";

// Six module dashboards, matching how the live system splits them. URL-driven
// pills, the same idiom Current Loans uses for its filters.
export const DASHBOARDS = [
  { key: "catalogue", label: "Catalogue" },
  { key: "items", label: "Items" },
  { key: "loans", label: "Loans" },
  { key: "acquisitions", label: "Purchase orders" },
  { key: "serials", label: "Serials" },
  { key: "portal", label: "Learner portal" },
] as const;

export function DashboardTabs({ active }: { active: string }) {
  return (
    <div className="mb-6 flex flex-wrap gap-2">
      <Link
        href="/admin"
        className="rounded-full bg-muted px-4 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        Overview
      </Link>
      {DASHBOARDS.map((d) => (
        <Link
          key={d.key}
          href={`/admin/dashboards/${d.key}`}
          className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
            active === d.key
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          {d.label}
        </Link>
      ))}
    </div>
  );
}

export function DashboardHeading({
  title,
  blurb,
}: {
  title: string;
  blurb: string;
}) {
  return (
    <div className="mb-5">
      <h1 className="font-display text-3xl font-semibold">{title}</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{blurb}</p>
    </div>
  );
}
