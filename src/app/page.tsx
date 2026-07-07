import Link from "next/link";
import { prisma } from "@/lib/db";
import { ButtonLink } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const [resources, copies, members, activeLoans] = await Promise.all([
    prisma.resource.count(),
    prisma.copy.count(),
    prisma.member.count(),
    prisma.loan.count({ where: { status: "ACTIVE" } }),
  ]);

  const stats = [
    { label: "Titles in catalogue", value: resources },
    { label: "Physical copies", value: copies },
    { label: "Registered members", value: members },
    { label: "Active loans", value: activeLoans },
  ];

  return (
    <main className="flex-1">
      <section className="hero-paper border-b border-border">
        <div className="mx-auto max-w-5xl px-6 py-20 text-center">
          <p className="mb-3 text-sm font-medium uppercase tracking-[0.2em] text-accent">
            Library Management Platform
          </p>
          <h1 className="font-display text-5xl font-semibold tracking-tight text-foreground sm:text-6xl">
            Athenaeum
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">
            One platform, two front doors — a discovery portal for learners and a
            back-office for library staff. Catalogue, circulate, reserve, and keep
            track of every title under one roof.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <ButtonLink href="/portal" variant="primary" className="px-6 py-3 text-base">
              Enter Learner Portal
            </ButtonLink>
            <ButtonLink href="/admin" variant="outline" className="px-6 py-3 text-base">
              Open Admin Panel
            </ButtonLink>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 py-12">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {stats.map((s) => (
            <div
              key={s.label}
              className="rounded-xl border border-border bg-card p-5 text-center shadow-sm"
            >
              <dt className="text-sm text-muted-foreground">{s.label}</dt>
              <dd className="mt-1 font-display text-3xl font-semibold text-primary">
                {s.value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mx-auto grid max-w-5xl gap-6 px-6 pb-20 sm:grid-cols-2">
        <PortalCard
          href="/portal"
          eyebrow="For learners"
          title="Learner Portal"
          description="Search and browse the collection, borrow digital titles instantly, reserve what's out, and track your loans."
          points={["Search & advanced filters", "Borrow & reserve", "My loans & reservations"]}
          tone="primary"
        />
        <PortalCard
          href="/admin"
          eyebrow="For staff"
          title="Admin Panel"
          description="Manage the catalogue and members, check items in and out, and keep an eye on loans, holds, and overdues."
          points={["Catalogue & members", "Check-out / check-in", "Dashboard & reservations"]}
          tone="accent"
        />
      </section>
    </main>
  );
}

function PortalCard({
  href,
  eyebrow,
  title,
  description,
  points,
  tone,
}: {
  href: string;
  eyebrow: string;
  title: string;
  description: string;
  points: string[];
  tone: "primary" | "accent";
}) {
  const accentBar = tone === "primary" ? "bg-primary" : "bg-accent";
  return (
    <Link
      href={href}
      className="group relative overflow-hidden rounded-2xl border border-border bg-card p-7 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <span className={`absolute inset-x-0 top-0 h-1 ${accentBar}`} />
      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {eyebrow}
      </p>
      <h3 className="mt-2 font-display text-2xl font-semibold text-foreground">
        {title}
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      <ul className="mt-4 space-y-1.5">
        {points.map((p) => (
          <li key={p} className="flex items-center gap-2 text-sm text-foreground">
            <span className={`h-1.5 w-1.5 rounded-full ${accentBar}`} />
            {p}
          </li>
        ))}
      </ul>
      <p className="mt-6 inline-flex items-center gap-1 text-sm font-medium text-primary group-hover:gap-2 transition-all">
        Enter
        <span aria-hidden>→</span>
      </p>
    </Link>
  );
}
