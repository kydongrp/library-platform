"use client";

import { useState } from "react";
import { StatefulForm, SubmitButton, ActionButton } from "@/components/forms";
import { Card, Badge } from "@/components/ui";
import {
  promoteToEditorsPick,
  addExternalPick,
  updatePick,
  recordSubmission,
  removeFromEditorsPick,
  keepPickInCatalogue,
} from "@/app/actions/editors-pick";
import { CATEGORIES, RESOURCE_TYPES, RESOURCE_TYPE_LABELS, PROVIDERS } from "@/lib/constants";

const fieldCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelCls = "mb-1 block text-xs font-medium text-muted-foreground";

export type TitleOption = { id: string; title: string; author: string };

function TitleSelect({ name, options, idPrefix }: { name: string; options: TitleOption[]; idPrefix: string }) {
  return (
    <select id={`${idPrefix}-resource`} name={name} required defaultValue="" className={fieldCls}>
      <option value="" disabled>
        Choose a catalogue title…
      </option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.title} ({o.author})
        </option>
      ))}
    </select>
  );
}

/** Promote an existing catalogue title to Editor's Pick. */
export function PromoteForm({ options }: { options: TitleOption[] }) {
  return (
    <Card className="p-5">
      <h2 className="font-display text-lg font-semibold">Promote a catalogue title</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Internal picks stay in the catalogue if later removed from the shelf.
      </p>
      <StatefulForm action={promoteToEditorsPick} className="mt-3 space-y-3">
        <div>
          <label className={labelCls} htmlFor="pf-resource">Title *</label>
          <TitleSelect name="resourceId" options={options} idPrefix="pf" />
        </div>
        <div>
          <label className={labelCls} htmlFor="pf-blurb">Curator&apos;s note</label>
          <textarea id="pf-blurb" name="blurb" rows={2} className={fieldCls}
            placeholder="Why it's featured, shown with the pick" />
        </div>
        <SubmitButton pendingLabel="Promoting…">★ Promote to Editor&apos;s Pick</SubmitButton>
      </StatefulForm>
    </Card>
  );
}

/** Add an external resource (e.g. a WhatsApp link) straight onto the shelf. */
export function ExternalPickForm() {
  return (
    <Card className="p-5">
      <h2 className="font-display text-lg font-semibold">Add an external pick</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        For links promoted from outside the collection (e.g. sent over WhatsApp).
        Removing an external pick later deletes it from the library entirely.
      </p>
      <StatefulForm action={addExternalPick} className="mt-3 space-y-3">
        <div>
          <label className={labelCls} htmlFor="xf-title">Title *</label>
          <input id="xf-title" name="title" required className={fieldCls} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="xf-authors">Author(s)</label>
            <input id="xf-authors" name="authors" className={fieldCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="xf-provider">Provider / source</label>
            <input id="xf-provider" name="provider" list="xf-providers" className={fieldCls}
              placeholder="e.g. IEEE Xplore, YouTube, MIT OCW" />
            <datalist id="xf-providers">
              {PROVIDERS.map((p) => <option key={p} value={p} />)}
            </datalist>
          </div>
        </div>
        <div>
          <label className={labelCls} htmlFor="xf-url">Access URL *</label>
          <input id="xf-url" name="url" type="url" required className={`${fieldCls} font-mono`}
            placeholder="https://…" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="xf-type">Type</label>
            <select id="xf-type" name="type" defaultValue="EBOOK" className={fieldCls}>
              {RESOURCE_TYPES.map((t) => (
                <option key={t} value={t}>{RESOURCE_TYPE_LABELS[t]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="xf-category">Category</label>
            <select id="xf-category" name="category" defaultValue="Technology" className={fieldCls}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className={labelCls} htmlFor="xf-blurb">Curator&apos;s note</label>
          <textarea id="xf-blurb" name="blurb" rows={2} className={fieldCls} />
        </div>
        <SubmitButton pendingLabel="Adding…">＋ Add external pick</SubmitButton>
      </StatefulForm>
    </Card>
  );
}

/** Record a learner submission retrieved from form.sg or WhatsApp. */
export function RecordSubmissionForm({ options }: { options: TitleOption[] }) {
  const [kind, setKind] = useState<"INTERNAL" | "EXTERNAL">("INTERNAL");
  return (
    <Card className="p-5">
      <h2 className="font-display text-lg font-semibold">Record a learner submission</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Enter nominations retrieved from the portal&apos;s form.sg responses or WhatsApp,
        then approve them below, with no re-typing at promotion time.
      </p>
      <StatefulForm action={recordSubmission} className="mt-3 space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className={labelCls} htmlFor="rs-kind">Nomination</label>
            <select id="rs-kind" name="kind" value={kind}
              onChange={(e) => setKind(e.target.value === "EXTERNAL" ? "EXTERNAL" : "INTERNAL")}
              className={fieldCls}>
              <option value="INTERNAL">Catalogue title</option>
              <option value="EXTERNAL">External link</option>
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="rs-channel">Received via</label>
            <select id="rs-channel" name="channel" defaultValue="FORMSG" className={fieldCls}>
              <option value="FORMSG">form.sg</option>
              <option value="WHATSAPP">WhatsApp</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="rs-submitter">Submitted by</label>
            <input id="rs-submitter" name="submitter" className={fieldCls} placeholder="Learner name / ID" />
          </div>
        </div>

        {kind === "INTERNAL" ? (
          <div>
            <label className={labelCls} htmlFor="rs-resource">Nominated title *</label>
            <TitleSelect name="resourceId" options={options} idPrefix="rs" />
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="rs-title">Title *</label>
                <input id="rs-title" name="title" required className={fieldCls} />
              </div>
              <div>
                <label className={labelCls} htmlFor="rs-authors">Author(s)</label>
                <input id="rs-authors" name="authors" className={fieldCls} />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
              <div>
                <label className={labelCls} htmlFor="rs-url">URL *</label>
                <input id="rs-url" name="url" type="url" required className={`${fieldCls} font-mono`}
                  placeholder="https://…" />
              </div>
              <div>
                <label className={labelCls} htmlFor="rs-provider">Provider</label>
                <input id="rs-provider" name="provider" className={fieldCls} />
              </div>
            </div>
          </>
        )}

        <div>
          <label className={labelCls} htmlFor="rs-reason">Learner&apos;s reason</label>
          <textarea id="rs-reason" name="reason" rows={2} className={fieldCls}
            placeholder="Copied from the form response; becomes the curator's note on approval" />
        </div>
        <SubmitButton variant="outline" pendingLabel="Recording…">✍ Record submission</SubmitButton>
      </StatefulForm>
    </Card>
  );
}

export type PickInfo = {
  id: string;
  title: string;
  author: string;
  epExternal: boolean;
  epBlurb: string | null;
  digitalUrl: string | null;
  type: string;
  category: string;
};

/** Inline editor + remove control for one current pick. */
export function PickActions({ pick }: { pick: PickInfo }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          {editing ? "Close" : "✎ Edit"}
        </button>
        {pick.epExternal && (
          <ActionButton
            action={keepPickInCatalogue}
            fields={{ id: pick.id }}
            variant="outline"
            className="!px-3 !py-1.5 text-xs"
            pendingLabel="Saving…"
            confirm={`Keep "${pick.title}" in the catalogue?\n\nIt becomes an internal pick. Removing it from Editor's Picks later will no longer delete it from the library.`}
          >
            ⬇ Keep in catalogue
          </ActionButton>
        )}
        <ActionButton
          action={removeFromEditorsPick}
          fields={{ id: pick.id }}
          variant="outline"
          className="!px-3 !py-1.5 text-xs !text-red-700"
          pendingLabel="Removing…"
          confirm={
            pick.epExternal
              ? `Remove "${pick.title}"?\n\nThis is an EXTERNAL pick, so it will be deleted from the library entirely.`
              : `Remove "${pick.title}" from Editor's Picks?\n\nIt stays in the catalogue; only the pick is removed.`
          }
        >
          ✕ Remove
        </ActionButton>
      </div>

      {editing && (
        <StatefulForm action={updatePick} className="mt-3 space-y-3 rounded-lg border border-border bg-muted/40 p-3">
          <input type="hidden" name="id" value={pick.id} />
          {pick.epExternal && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelCls}>Title *</label>
                  <input name="title" defaultValue={pick.title} required className={fieldCls} />
                </div>
                <div>
                  <label className={labelCls}>Author(s)</label>
                  <input name="authors" defaultValue={pick.author} className={fieldCls} />
                </div>
              </div>
              <div>
                <label className={labelCls}>Access URL *</label>
                <input name="url" type="url" defaultValue={pick.digitalUrl ?? ""} required
                  className={`${fieldCls} font-mono`} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelCls}>Type</label>
                  <select name="type" defaultValue={pick.type} className={fieldCls}>
                    {RESOURCE_TYPES.map((t) => (
                      <option key={t} value={t}>{RESOURCE_TYPE_LABELS[t]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Category</label>
                  <select name="category" defaultValue={pick.category} className={fieldCls}>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>
            </>
          )}
          <div>
            <label className={labelCls}>Curator&apos;s note</label>
            <textarea name="blurb" rows={2} defaultValue={pick.epBlurb ?? ""} className={fieldCls} />
          </div>
          <SubmitButton className="!px-4 !py-1.5 text-xs" pendingLabel="Saving…">Save</SubmitButton>
        </StatefulForm>
      )}
    </div>
  );
}

export function KindBadge({ external }: { external: boolean }) {
  return external ? (
    <Badge tone="accent">external</Badge>
  ) : (
    <Badge tone="primary">internal</Badge>
  );
}
