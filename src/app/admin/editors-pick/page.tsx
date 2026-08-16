import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import {
  approveSubmission,
  rejectSubmission,
  promoteToEditorsPick,
  dismissSuggestion,
  restoreSuggestion,
} from "@/app/actions/editors-pick";
import { getCurationSuggestions, DEMAND_WINDOW_DAYS } from "@/lib/curation";
import { formatDate } from "@/lib/format";
import { RESOURCE_TYPE_LABELS } from "@/lib/constants";
import {
  PromoteForm,
  ExternalPickForm,
  RecordSubmissionForm,
  PickActions,
  KindBadge,
  type TitleOption,
} from "./widgets";

export const dynamic = "force-dynamic";

const CHANNEL_LABELS: Record<string, string> = {
  FORMSG: "form.sg",
  WHATSAPP: "WhatsApp",
  OTHER: "Other",
};

export default async function EditorsPickPage() {
  const admin = await requireAdminView("CATALOGUE");
  const editable = canEdit(admin, "CATALOGUE");

  // Pending and decided are queried separately: a shared capped query sorted
  // by status would let decided history crowd pending items out of view.
  const [picks, pending, decided, candidates, curation] = await Promise.all([
    prisma.resource.findMany({
      where: { editorsPick: true },
      orderBy: { epPickedAt: { sort: "desc", nulls: "last" } },
    }),
    prisma.epSubmission.findMany({
      where: { status: "PENDING" },
      include: { resource: { select: { title: true, author: true, editorsPick: true } } },
      orderBy: { createdAt: "asc" }, // oldest first — review in arrival order
    }),
    prisma.epSubmission.findMany({
      where: { status: { not: "PENDING" } },
      include: { resource: { select: { title: true, author: true, editorsPick: true } } },
      orderBy: { updatedAt: "desc" },
      take: 12,
    }),
    prisma.resource.findMany({
      where: { editorsPick: false },
      select: { id: true, title: true, author: true },
      orderBy: { title: "asc" },
      take: 500, // bound the dropdown payload; typeahead search is the upgrade path
    }),
    getCurationSuggestions(),
  ]);

  const options: TitleOption[] = candidates;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Editor&apos;s Picks</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          The staff-curated shelf featured on the Learner Portal. Learner nominations
          arrive via the portal&apos;s form.sg flow (or WhatsApp for external links) —
          record them here and approve to promote in one click. Removing an{" "}
          <strong>external</strong> pick deletes it from the library; removing an{" "}
          <strong>internal</strong> pick keeps the title in the catalogue.
        </p>
      </div>

      {/* Submission queue */}
      <h2 className="mb-2 font-display text-lg font-semibold">
        Learner submissions awaiting review{" "}
        {pending.length > 0 && <Badge tone="accent">{pending.length}</Badge>}
      </h2>
      {pending.length === 0 ? (
        <EmptyState
          title="No submissions waiting"
          description="Record retrieved form.sg / WhatsApp nominations below and they'll queue here."
        />
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {pending.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium leading-snug">
                  {s.kind === "INTERNAL" ? s.resource?.title ?? "(deleted title)" : s.title}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {s.kind === "INTERNAL" ? s.resource?.author : s.authors || s.provider || s.url}
                </p>
                {s.reason && <p className="mt-1 text-xs italic text-muted-foreground">“{s.reason}”</p>}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <KindBadge external={s.kind === "EXTERNAL"} />
                  {s.kind === "INTERNAL" && s.resource?.editorsPick && (
                    <Badge tone="success">already a pick</Badge>
                  )}
                  <Badge tone="muted">{CHANNEL_LABELS[s.channel] ?? s.channel}</Badge>
                  {s.submitter && <Badge tone="neutral">{s.submitter}</Badge>}
                  <span className="text-xs text-muted-foreground">{formatDate(s.createdAt)}</span>
                  {s.kind === "EXTERNAL" && s.url && (
                    <a href={s.url} target="_blank" rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline">
                      preview ↗
                    </a>
                  )}
                </div>
              </div>
              {editable && (
                <div className="flex items-center gap-2">
                  <ActionButton action={approveSubmission} fields={{ id: s.id }}
                    className="!px-3 !py-1.5 text-xs" pendingLabel="Approving…">
                    ✓ Approve
                  </ActionButton>
                  <ActionButton action={rejectSubmission} fields={{ id: s.id }} variant="outline"
                    className="!px-3 !py-1.5 text-xs" pendingLabel="Rejecting…"
                    confirm={`Reject this nomination${s.submitter ? ` from ${s.submitter}` : ""}?`}>
                    ✕ Reject
                  </ActionButton>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      {/* Auto-curation suggestions */}
      <h2 className="mb-1 mt-8 font-display text-lg font-semibold">
        Suggested picks{" "}
        {curation.suggestions.length > 0 && (
          <Badge tone="accent">{curation.suggestions.length}</Badge>
        )}
      </h2>
      <p className="mb-2 max-w-3xl text-xs text-muted-foreground">
        Catalogue titles scored from circulation demand ({DEMAND_WINDOW_DAYS}-day
        loans and holds), learner ratings, new arrivals, and shelf variety —
        with the evidence shown, so you judge. Broken-link titles and rejected
        nominations are excluded. Nothing is promoted automatically.
      </p>
      {curation.suggestions.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
          No stand-out candidates right now — suggestions appear as loans,
          ratings, and new arrivals accumulate.
        </p>
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {curation.suggestions.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 font-display text-sm font-bold text-primary"
                title={`Suggestion score ${s.score}`}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {s.score}
              </span>
              <div className="min-w-0 flex-1">
                <Link href={`/admin/catalogue/${s.id}`} className="font-medium leading-snug hover:underline">
                  {s.title}
                </Link>
                <p className="mt-0.5 text-sm text-muted-foreground">{s.author}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge tone="muted">{RESOURCE_TYPE_LABELS[s.type] ?? s.type}</Badge>
                  <Badge tone="muted">{s.category}</Badge>
                  {s.provider && <Badge tone="neutral">{s.provider}</Badge>}
                  {s.reasons.map((reason) => (
                    <span
                      key={reason}
                      className="rounded-full bg-teal-50 px-2 py-0.5 text-xs text-teal-900 ring-1 ring-inset ring-teal-200"
                    >
                      {reason}
                    </span>
                  ))}
                </div>
              </div>
              {editable && (
                <div className="flex items-center gap-2">
                  <ActionButton action={promoteToEditorsPick} fields={{ resourceId: s.id }}
                    className="!px-3 !py-1.5 text-xs" pendingLabel="Promoting…">
                    ★ Promote
                  </ActionButton>
                  <ActionButton action={dismissSuggestion} fields={{ resourceId: s.id }}
                    variant="outline" className="!px-3 !py-1.5 text-xs" pendingLabel="Dismissing…">
                    Dismiss
                  </ActionButton>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
      {curation.dismissed.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Dismissed suggestions ({curation.dismissed.length})
          </summary>
          <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
            {curation.dismissed.map((d) => (
              <li key={d.resourceId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                <span className="min-w-0 truncate text-sm">{d.title}</span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    by {d.dismissedBy} · {formatDate(d.dismissedAt)}
                  </span>
                  {editable && (
                    <ActionButton action={restoreSuggestion} fields={{ resourceId: d.resourceId }}
                      variant="ghost" className="!px-2 !py-1 text-xs" pendingLabel="…">
                      Restore
                    </ActionButton>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Intake + promote tools */}
      {editable && (
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <RecordSubmissionForm options={options} />
          <div className="space-y-6">
            <PromoteForm options={options} />
            <ExternalPickForm />
          </div>
        </div>
      )}

      {/* Current shelf */}
      <h2 className="mb-2 mt-10 font-display text-lg font-semibold">
        Current picks {picks.length > 0 && <Badge tone="primary">{picks.length}</Badge>}
      </h2>
      {picks.length === 0 ? (
        <EmptyState
          title="The shelf is empty"
          description="Promote a catalogue title or add an external pick to start curating."
        />
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {picks.map((p) => (
            <div key={p.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <span
                className="mt-0.5 flex h-10 w-8 shrink-0 items-center justify-center rounded font-display text-xs font-bold text-white"
                style={{ backgroundColor: p.coverColor }}
              >
                ★
              </span>
              <div className="min-w-0 flex-1">
                <Link href={`/admin/catalogue/${p.id}`} className="font-medium leading-snug hover:underline">
                  {p.title}
                </Link>
                <p className="mt-0.5 text-sm text-muted-foreground">{p.author}</p>
                {p.epBlurb && (
                  <p className="mt-1 text-xs italic text-muted-foreground">“{p.epBlurb}”</p>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <KindBadge external={p.epExternal} />
                  <Badge tone="muted">{RESOURCE_TYPE_LABELS[p.type] ?? p.type}</Badge>
                  {p.provider && <Badge tone="neutral">{p.provider}</Badge>}
                  {p.epPickedBy && (
                    <span className="text-xs text-muted-foreground">
                      picked by {p.epPickedBy}
                      {p.epPickedAt ? ` · ${formatDate(p.epPickedAt)}` : ""}
                    </span>
                  )}
                  {p.digitalUrl && (
                    <a href={p.digitalUrl} target="_blank" rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline">
                      open ↗
                    </a>
                  )}
                </div>
                {editable && (
                  <div className="mt-2">
                    <PickActions
                      pick={{
                        id: p.id,
                        title: p.title,
                        author: p.author,
                        epExternal: p.epExternal,
                        epBlurb: p.epBlurb,
                        digitalUrl: p.digitalUrl,
                        type: p.type,
                        category: p.category,
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* Recently decided submissions */}
      {decided.length > 0 && (
        <>
          <h2 className="mb-2 mt-10 font-display text-lg font-semibold">Recently decided</h2>
          <Card className="divide-y divide-border overflow-hidden">
            {decided.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {s.kind === "INTERNAL" ? s.resource?.title ?? "(deleted title)" : s.title}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {CHANNEL_LABELS[s.channel] ?? s.channel}
                    {s.submitter ? ` · ${s.submitter}` : ""} · decided by {s.decidedBy ?? "—"}
                    {s.staffNote ? ` · ${s.staffNote}` : ""}
                  </p>
                </div>
                <Badge tone={s.status === "APPROVED" ? "success" : "danger"}>
                  {s.status.toLowerCase()}
                </Badge>
              </div>
            ))}
          </Card>
        </>
      )}
    </div>
  );
}
