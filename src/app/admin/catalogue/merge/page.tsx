import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { mergeBibs } from "@/app/actions/marc";
import { planMerge } from "@/lib/bib-merge";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ winner?: string; loser?: string }>;

export default async function MergeBibPage({ searchParams }: { searchParams: SearchParams }) {
  const admin = await requireAdminView("CATALOGUE");
  const editable = canEdit(admin, "CATALOGUE");
  const { winner = "", loser = "" } = await searchParams;

  const [choices, plan, recentMerges] = await Promise.all([
    prisma.resource.findMany({
      select: { id: true, title: true, author: true, isbn: true },
      orderBy: { title: "asc" },
      take: 800,
    }),
    winner && loser ? planMerge(winner, loser) : Promise.resolve(null),
    prisma.bibMerge.findMany({ orderBy: { mergedAt: "desc" }, take: 10 }),
  ]);

  const inputCls =
    "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
  const blocked = (plan?.blockers.length ?? 0) > 0;

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/admin/catalogue" className="text-sm text-muted-foreground hover:text-foreground">
        Back to catalogue
      </Link>

      <div className="mb-6 mt-3">
        <h1 className="font-display text-3xl font-semibold">Merge duplicate records</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Fold a duplicate bibliographic record into the one you are keeping.
          Copies, loan history, holds, reviews, favourites, nominations and
          catalogued MARC fields all move across, then the duplicate is removed.
          Nothing happens until you confirm the plan below.
        </p>
      </div>

      {/* Pick the pair */}
      <Card className="mb-6 p-5">
        <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div>
            <label htmlFor="mb-keep" className="mb-1 block text-xs font-medium text-muted-foreground">
              Record to KEEP
            </label>
            <input id="mb-keep" name="winner" defaultValue={winner} list="bib-options"
              placeholder="Paste or pick the surviving record" className={inputCls} />
          </div>
          <div>
            <label htmlFor="mb-drop" className="mb-1 block text-xs font-medium text-muted-foreground">
              Duplicate to ABSORB
            </label>
            <input id="mb-drop" name="loser" defaultValue={loser} list="bib-options"
              placeholder="This record will be removed" className={inputCls} />
          </div>
          <button type="submit"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
            Preview merge
          </button>
        </form>
        <datalist id="bib-options">
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title} · {c.author}{c.isbn ? ` (${c.isbn})` : ""}
            </option>
          ))}
        </datalist>
        <p className="mt-2 text-xs text-muted-foreground">
          The picker lists record identifiers. From a record page, use Merge into
          another record to arrive here with the duplicate already filled in.
        </p>
      </Card>

      {/* The plan */}
      {winner && loser && !plan && (
        <p className="mb-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          One of those records could not be found. Check both identifiers.
        </p>
      )}

      {plan && (
        <Card className={`mb-6 p-5 ${blocked ? "border-red-200" : ""}`}>
          <h2 className="mb-3 font-display text-lg font-semibold">Merge plan</h2>

          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-green-200 bg-green-50/60 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-green-800">Keeping</p>
              <p className="mt-0.5 font-medium">{plan.winner.title}</p>
              <p className="text-sm text-muted-foreground">{plan.winner.author}</p>
            </div>
            <div className="rounded-lg border border-red-200 bg-red-50/60 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-red-800">Absorbing and removing</p>
              <p className="mt-0.5 font-medium">{plan.loser.title}</p>
              <p className="text-sm text-muted-foreground">{plan.loser.author}</p>
            </div>
          </div>

          {blocked ? (
            <div className="rounded-lg bg-red-50 px-4 py-3">
              <p className="mb-1 text-sm font-medium text-red-800">This merge cannot run:</p>
              <ul className="list-disc pl-5 text-sm text-red-700">
                {plan.blockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            </div>
          ) : (
            <>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">What moves across</p>
              {plan.moves.length === 0 ? (
                <p className="mb-3 text-sm text-muted-foreground">
                  Nothing is attached to the duplicate. Only the record itself is removed.
                </p>
              ) : (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {plan.moves.map((m) => (
                    <Badge key={m.label} tone="primary">{m.count} {m.label.toLowerCase()}</Badge>
                  ))}
                </div>
              )}

              {plan.drops.length > 0 && (
                <>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                    Dropped as duplicates
                  </p>
                  <ul className="mb-3 list-disc pl-5 text-sm text-muted-foreground">
                    {plan.drops.map((d) => (
                      <li key={d.label}>
                        {d.count} {d.label.toLowerCase()} ({d.reason})
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {plan.decisions.length > 0 && (
                <>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">Applied to the surviving record</p>
                  <ul className="mb-4 list-disc pl-5 text-sm">
                    {plan.decisions.map((d) => <li key={d}>{d}</li>)}
                  </ul>
                </>
              )}

              {editable && (
                <ActionButton
                  action={mergeBibs}
                  fields={{ winnerId: plan.winner.id, loserId: plan.loser.id }}
                  variant="danger"
                  pendingLabel="Merging…"
                  confirm={`Merge "${plan.loser.title}" into "${plan.winner.title}"? This removes the duplicate and cannot be undone.`}
                >
                  Merge and remove the duplicate
                </ActionButton>
              )}
            </>
          )}
        </Card>
      )}

      {/* Tombstones */}
      <Card className="p-5">
        <h2 className="mb-1 font-display text-lg font-semibold">Recent merges</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Every merge leaves a record of which identifier was absorbed, so an old
          link or an audit entry pointing at the removed record can still be traced.
        </p>
        {recentMerges.length === 0 ? (
          <EmptyState title="No merges yet" description="Merged records are listed here with what moved." />
        ) : (
          <ul className="divide-y divide-border">
            {recentMerges.map((m) => (
              <li key={m.id} className="py-2">
                <p className="text-sm">
                  <span className="font-medium">{m.loserTitle}</span> was merged into{" "}
                  <Link href={`/admin/catalogue/${m.winnerId}`} className="text-primary hover:underline">
                    the surviving record
                  </Link>
                </p>
                <p className="text-xs text-muted-foreground">
                  {m.mergedBy} · {formatDate(m.mergedAt)} · absorbed id{" "}
                  <span className="font-mono">{m.loserId}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
