"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { addResourceFromUrl, type IntakeState } from "@/app/actions/intake";

/** Idle state lives here: a "use server" module may only export async functions. */
const idle: IntakeState = {};

/**
 * Paste a link, get a catalogue record.
 *
 * Pure UI: nothing prisma-backed is imported, so the client bundle stays clean.
 * The provider list and the input cap arrive as props for the same reason.
 *
 * The result panel is the point of the screen, not a toast. Somebody pasting a
 * link wants the URL back, and wants to see what was understood from the page
 * before trusting it, so the record's fields and where they came from are shown
 * alongside the links rather than announced and dismissed.
 */
function AddButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-70"
    >
      {pending && (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground" />
      )}
      {pending ? "Reading the page…" : "Add to catalogue"}
    </button>
  );
}

function CopyLink({ href, label }: { href: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        // The clipboard API is unavailable over plain http and in some
        // embedded views, so a failure must not look like nothing happened.
        navigator.clipboard
          ?.writeText(href)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          })
          .catch(() => setCopied(false));
      }}
      className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-muted"
      aria-label={`Copy the ${label} link`}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function LinkRow({ label, href, external }: { label: string; href: string; external?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-1">
      <span className="min-w-28 text-xs text-muted-foreground">{label}</span>
      {external ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 truncate font-mono text-xs text-primary hover:underline"
        >
          {href}
        </a>
      ) : (
        <Link href={href} className="min-w-0 flex-1 truncate font-mono text-xs text-primary hover:underline">
          {href}
        </Link>
      )}
      <CopyLink href={href} label={label} />
    </div>
  );
}

export function IntakeForm({
  maxLength,
  providerGroups,
}: {
  maxLength: number;
  providerGroups: { label: string; providers: readonly string[] }[];
}) {
  const [state, formAction] = useActionState(addResourceFromUrl, idle);
  const [text, setText] = useState("");
  const r = state.result;

  return (
    <>
      <form action={formAction} className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium" htmlFor="intake-input">
            Link or DOI
          </label>
          <textarea
            id="intake-input"
            name="input"
            rows={2}
            maxLength={maxLength}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="https://ieeexplore.ieee.org/document/…  or  10.1109/EXAMPLE.2024.1234"
            className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            A DOI is resolved through Crossref without fetching anything. A link is fetched once,
            and the record is built from what the page says about itself.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1.5 block text-sm font-medium" htmlFor="intake-provider">
              Provider <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <select
              id="intake-provider"
              name="provider"
              defaultValue=""
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="">None (open web link)</option>
              {providerGroups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.providers.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              Set this for subscription content so the link is proxied and the title counts towards
              that provider&rsquo;s usage.
            </p>
          </div>
          <div className="ml-auto">
            <AddButton />
          </div>
        </div>
      </form>

      {state.ok === false && state.message && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.message}
        </p>
      )}

      {state.ok && r && (
        <div
          className={`mt-4 rounded-lg border p-4 ${
            r.status === "created" ? "border-primary/30 bg-primary/5" : "border-border bg-muted/40"
          }`}
        >
          <p className="text-sm font-medium">
            {r.status === "created" ? "Added to the catalogue" : "Already in the library"}
          </p>

          <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            {(
              [
                ["Title", r.title],
                ["Authors", r.authors],
                ["Publisher", r.publisher ?? "Not stated"],
                ["Year", r.year ? String(r.year) : "Not stated"],
                ["Type", r.type],
                ["Category", "Uncategorised"],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="min-w-20 shrink-0 text-muted-foreground">{k}</dt>
                <dd className="min-w-0 break-words font-medium">{v}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-2 text-xs text-muted-foreground">{r.provenance}</p>
          {r.warning && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {r.warning} The title was taken from the web address, so check it.
            </p>
          )}

          <div className="mt-3 border-t border-border pt-2">
            <LinkRow label="Catalogue record" href={r.links.catalogue} />
            {r.links.access && <LinkRow label="Access link" href={r.links.access} external />}
            {r.links.portal ? (
              <LinkRow label="Learner portal" href={r.links.portal} external />
            ) : (
              <p className="py-1 text-xs text-muted-foreground">
                No learner-portal link: <code className="font-mono">PORTAL_RESOURCE_URL</code> is
                not configured, so this system does not know the portal&rsquo;s URL shape.
              </p>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Link
              href={r.links.catalogue}
              className="inline-flex items-center rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
            >
              Open the record
            </Link>
            <button
              type="button"
              onClick={() => setText("")}
              className="text-xs font-medium text-primary hover:underline"
            >
              Add another
            </button>
          </div>
        </div>
      )}
    </>
  );
}
