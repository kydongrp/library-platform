"use client";

import { useState } from "react";
import { StatefulForm, SubmitButton } from "@/components/forms";
import { Card } from "@/components/ui";
import { importScholarly, addManualArticle } from "@/app/actions/import";
import { CATEGORIES, RESOURCE_TYPES, RESOURCE_TYPE_LABELS } from "@/lib/constants";
import type { ScholarlyRecord } from "@/lib/scholarly";

const selectCls = "rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs";

/** Per-row import: pick a category, import one record. */
export function ImportButton({ record }: { record: ScholarlyRecord }) {
  const [category, setCategory] = useState("Technology");
  return (
    <StatefulForm action={importScholarly} className="flex items-center gap-2">
      <input type="hidden" name="records" value={JSON.stringify(record)} />
      <input type="hidden" name="category" value={category} />
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        aria-label="Category"
        className={selectCls}
      >
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      <SubmitButton variant="outline" className="!px-3 !py-1.5 text-xs" pendingLabel="Importing…">
        ⇩ Import
      </SubmitButton>
    </StatefulForm>
  );
}

/** Bulk import bar: import every not-yet-imported result on the page. */
export function ImportAllBar({ records, count }: { records: ScholarlyRecord[]; count: number }) {
  const [category, setCategory] = useState("Technology");
  return (
    <StatefulForm
      action={importScholarly}
      className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3"
    >
      <input type="hidden" name="records" value={JSON.stringify(records)} />
      <input type="hidden" name="category" value={category} />
      <p className="text-sm">
        <span className="font-medium">{count}</span> new record{count === 1 ? "" : "s"} on this page
      </p>
      <div className="ml-auto flex items-center gap-2">
        <label className="text-xs text-muted-foreground" htmlFor="bulk-category">Category</label>
        <select
          id="bulk-category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className={selectCls}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <SubmitButton className="!px-4 !py-1.5 text-sm" pendingLabel="Importing…">
          ⇩ Import all {count}
        </SubmitButton>
      </div>
    </StatefulForm>
  );
}

const fieldCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelCls = "mb-1 block text-xs font-medium text-muted-foreground";

/**
 * Manual add for scholarly articles from sources without a search API
 * (Janes, Knovel, IHS, etc.). Creates a digital, link-out resource.
 */
export function ManualArticleForm({ providers }: { providers: readonly string[] }) {
  const [provider, setProvider] = useState(providers[0] ?? "");
  return (
    <Card className="max-w-3xl p-5">
      <h2 className="font-display text-lg font-semibold">Add an article manually</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        For subscription sources with no search API (e.g. Janes). Saved as a digital
        resource that links out to the provider, exactly like imported IEEE content.
      </p>
      <StatefulForm action={addManualArticle} className="mt-4 space-y-4">
        {(state) => (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="ma-provider">Provider *</label>
                <select id="ma-provider" name="provider" value={provider}
                  onChange={(e) => setProvider(e.target.value)} className={fieldCls}>
                  {providers.map((p) => <option key={p} value={p}>{p}</option>)}
                  <option value="__custom__">Other…</option>
                </select>
                {provider === "__custom__" && (
                  <input name="customProvider" placeholder="Provider name" className={`${fieldCls} mt-2`} />
                )}
              </div>
              <div>
                <label className={labelCls} htmlFor="ma-type">Type</label>
                <select id="ma-type" name="type" defaultValue="JOURNAL" className={fieldCls}>
                  {RESOURCE_TYPES.map((t) => <option key={t} value={t}>{RESOURCE_TYPE_LABELS[t]}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className={labelCls} htmlFor="ma-title">Title *</label>
              <input id="ma-title" name="title" required className={fieldCls}
                placeholder="e.g. Jane's Defence Weekly — Naval Systems Assessment" />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="ma-authors">Author(s)</label>
                <input id="ma-authors" name="authors" className={fieldCls} placeholder="e.g. IHS Markit" />
              </div>
              <div>
                <label className={labelCls} htmlFor="ma-venue">Publication / venue</label>
                <input id="ma-venue" name="venue" className={fieldCls} placeholder="e.g. Jane's Fighting Ships" />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
              <div>
                <label className={labelCls} htmlFor="ma-url">Access URL *</label>
                <input id="ma-url" name="url" type="url" required className={`${fieldCls} font-mono`}
                  placeholder="https://customer.janes.com/…" />
              </div>
              <div>
                <label className={labelCls} htmlFor="ma-year">Year</label>
                <input id="ma-year" name="year" type="number" min="0" max="2100" className={fieldCls} />
              </div>
            </div>

            <div>
              <label className={labelCls} htmlFor="ma-category">Category</label>
              <select id="ma-category" name="category" defaultValue="Technology" className={fieldCls}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <div>
              <label className={labelCls} htmlFor="ma-abstract">Abstract / notes</label>
              <textarea id="ma-abstract" name="abstract" rows={3} className={fieldCls} />
            </div>

            {state.ok === false && state.message && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{state.message}</p>
            )}
            <SubmitButton pendingLabel="Adding…">Add to catalogue</SubmitButton>
          </>
        )}
      </StatefulForm>
    </Card>
  );
}
