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
            Digital Library System
          </p>
          <h1 className="font-display text-5xl font-semibold tracking-tight text-foreground sm:text-6xl">
            DLS Admin
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">
            The staff back-office for the DLS (Digital Library System) —
            catalogue and members, circulation, loan policies, reporting, and
            scholarly content import, all in one place.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <ButtonLink href="/admin" variant="primary" className="px-6 py-3 text-base">
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
    </main>
  );
}
