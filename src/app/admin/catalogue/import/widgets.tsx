"use client";

import { useState } from "react";
import { StatefulForm, SubmitButton } from "@/components/forms";
import { Card } from "@/components/ui";
import { importScholarly, addManualArticle, bulkImportArticles } from "@/app/actions/import";
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

/**
 * Bulk import a whole batch file (Janes XML, an Excel/CSV export, or JSON) as
 * digital link-out resources tagged with one provider. Every record is deduped
 * against the catalogue, and the result reports imported / duplicate / skipped
 * counts with reasons.
 */
export function BulkImportForm({ providers }: { providers: readonly string[] }) {
  const [provider, setProvider] = useState(
    (providers as readonly string[]).includes("Janes") ? "Janes" : providers[0] ?? "",
  );

  function downloadTemplate() {
    const csv = [
      "title,authors,venue,year,url,type,category,abstract",
      `"Jane's Defence Weekly — Indo-Pacific Naval Modernisation","Jane's editorial team","Jane's Defence Weekly",2025,https://customer.janes.com/display/JDW-0001,JOURNAL,Technology,"Regional naval build-up analysis."`,
      `"Jane's Land Warfare Platforms — Tracked Vehicles","Jane's editorial team","Jane's Land Warfare Platforms",2024,https://customer.janes.com/display/JLWP-0007,EBOOK,Technology,"Reference entry on tracked platforms."`,
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "janes-batch-template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <Card className="max-w-3xl p-5">
      <h2 className="font-display text-lg font-semibold">Bulk import a batch file</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Upload a whole Janes/Knovel batch — <strong>CSV, JSON or XML</strong> — and every
        record is imported as a digital, link-out resource under the chosen provider.
        Fields are matched leniently and each record is deduped against the catalogue.
      </p>
      <StatefulForm action={bulkImportArticles} className="mt-4 space-y-4">
        {(state) => (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className={labelCls} htmlFor="bi-provider">Provider *</label>
                <select id="bi-provider" name="provider" value={provider}
                  onChange={(e) => setProvider(e.target.value)} className={fieldCls}>
                  {providers.map((p) => <option key={p} value={p}>{p}</option>)}
                  <option value="__custom__">Other…</option>
                </select>
                {provider === "__custom__" && (
                  <input name="customProvider" placeholder="Provider name" className={`${fieldCls} mt-2`} />
                )}
              </div>
              <div>
                <label className={labelCls} htmlFor="bi-type">Default type</label>
                <select id="bi-type" name="type" defaultValue="JOURNAL" className={fieldCls}>
                  {RESOURCE_TYPES.map((t) => <option key={t} value={t}>{RESOURCE_TYPE_LABELS[t]}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls} htmlFor="bi-category">Default category</label>
                <select id="bi-category" name="category" defaultValue="Technology" className={fieldCls}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className={labelCls} htmlFor="bi-file">Batch file</label>
              <input id="bi-file" name="file" type="file"
                accept=".csv,.tsv,.json,.xml,text/csv,application/json,text/xml,application/xml"
                className={`${fieldCls} file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1 file:text-xs file:font-medium file:text-primary`} />
              <p className="mt-1 text-xs text-muted-foreground">
                Recognised fields: title, authors, url, year, venue, type, category, abstract.{" "}
                <button type="button" onClick={downloadTemplate} className="text-primary hover:underline">
                  Download CSV template
                </button>
              </p>
            </div>

            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" /> or paste records <span className="h-px flex-1 bg-border" />
            </div>

            <div>
              <label className={labelCls} htmlFor="bi-pasted">Paste CSV rows, a JSON array, or XML</label>
              <textarea id="bi-pasted" name="pasted" rows={6} className={`${fieldCls} font-mono text-xs`}
                placeholder={`title,authors,url,year,venue\nJane's Fighting Ships 2025,Jane's,https://customer.janes.com/…,2025,Jane's Fighting Ships`} />
            </div>

            {state.ok !== undefined && state.message && (
              <p className={`rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>
                {state.message}
              </p>
            )}
            <SubmitButton pendingLabel="Importing…">Import batch</SubmitButton>
          </>
        )}
      </StatefulForm>
    </Card>
  );
}
