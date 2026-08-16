"use client";

import { useState, type FormEvent } from "react";
import { StatefulForm, SubmitButton } from "@/components/forms";
import { Card, buttonVariants } from "@/components/ui";
import { importScholarly, addManualArticle, importResourceRows, draftArticle } from "@/app/actions/import";
import type { ArticleDraft } from "@/lib/ai-draft";
import { useToast } from "@/components/toast";
import { CATEGORIES, RESOURCE_TYPES, RESOURCE_TYPE_LABELS } from "@/lib/constants";
import { parseBulk, type BulkRow } from "@/lib/bulk-import";
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

const SOURCE_LABELS: Record<ArticleDraft["source"], string> = {
  crossref: "Crossref (DOI registry)",
  "ai+page": "AI · read from the page",
  ai: "AI · bibliographic knowledge",
};

/**
 * Manual add for scholarly articles from sources without a search API
 * (Janes, Knovel, IHS, etc.). Creates a digital, link-out resource. The AI
 * assistant drafts the fields from a DOI/URL/citation; staff review and save.
 */
export function ManualArticleForm({
  providers,
  aiEnabled,
}: {
  providers: readonly string[];
  aiEnabled: boolean;
}) {
  const [provider, setProvider] = useState(providers[0] ?? "");
  const [draftInput, setDraftInput] = useState("");
  const [draft, setDraft] = useState<ArticleDraft | null>(null);
  const [draftRev, setDraftRev] = useState(0); // remounts the fields with new defaults
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftWarning, setDraftWarning] = useState<string | null>(null);

  async function runDraft() {
    if (draftBusy || !draftInput.trim()) return;
    setDraftBusy(true);
    setDraftError(null);
    setDraftWarning(null);
    const result = await draftArticle(draftInput);
    setDraftBusy(false);
    if (!result.ok) {
      setDraftError(result.error);
      return;
    }
    setDraft(result.draft);
    setDraftWarning(result.warning);
    setDraftRev((r) => r + 1);
  }

  return (
    <Card className="max-w-3xl p-5">
      <h2 className="font-display text-lg font-semibold">Add an article manually</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        For subscription sources with no search API (e.g. Janes). Saved as a digital
        resource that links out to the provider, exactly like imported IEEE content.
      </p>

      {/* AI draft box */}
      <div className="mt-4 rounded-xl border border-dashed border-primary/40 bg-primary/5 p-4">
        <p className="text-sm font-medium">✨ Draft with AI</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Paste a DOI, URL, or citation and the assistant fills the form below for your
          review — nothing is saved until you check the fields and click Add.
          {!aiEnabled && " DOIs resolve via Crossref; set ANTHROPIC_API_KEY to enable URL and free-text drafting."}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            value={draftInput}
            onChange={(e) => setDraftInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void runDraft();
              }
            }}
            placeholder="e.g. 10.1109/TSE.2024.1234567 · https://customer.janes.com/… · Clean Code, Robert Martin, 2008"
            className={`${fieldCls} min-w-64 flex-1 font-mono text-xs`}
            aria-label="DOI, URL, or citation to draft from"
          />
          <button
            type="button"
            onClick={() => void runDraft()}
            disabled={draftBusy || !draftInput.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
          >
            {draftBusy ? "Drafting…" : "Draft"}
          </button>
        </div>
        {draftError && (
          <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{draftError}</p>
        )}
        {draft && !draftError && (
          <div className="mt-2 space-y-1">
            <p className="text-xs text-muted-foreground">
              <span className="mr-1.5 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">
                {SOURCE_LABELS[draft.source]}
              </span>
              {draft.note} Review every field before saving.
            </p>
            {draftWarning && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">⚠ {draftWarning}</p>
            )}
          </div>
        )}
      </div>
      <StatefulForm action={addManualArticle} className="mt-4">
        {(state) => (
          <div key={draftRev} className="space-y-4">
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
                <select id="ma-type" name="type" defaultValue={draft?.type ?? "JOURNAL"} className={fieldCls}>
                  {RESOURCE_TYPES.map((t) => <option key={t} value={t}>{RESOURCE_TYPE_LABELS[t]}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className={labelCls} htmlFor="ma-title">Title *</label>
              <input id="ma-title" name="title" required className={fieldCls}
                defaultValue={draft?.title ?? ""}
                placeholder="e.g. Jane's Defence Weekly — Naval Systems Assessment" />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="ma-authors">Author(s)</label>
                <input id="ma-authors" name="authors" className={fieldCls}
                  defaultValue={draft?.authors ?? ""} placeholder="e.g. IHS Markit" />
              </div>
              <div>
                <label className={labelCls} htmlFor="ma-venue">Publication / venue</label>
                <input id="ma-venue" name="venue" className={fieldCls}
                  defaultValue={draft?.venue ?? ""} placeholder="e.g. Jane's Fighting Ships" />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
              <div>
                <label className={labelCls} htmlFor="ma-url">Access URL *</label>
                <input id="ma-url" name="url" type="url" required className={`${fieldCls} font-mono`}
                  defaultValue={draft?.url ?? ""}
                  placeholder="https://customer.janes.com/…" />
              </div>
              <div>
                <label className={labelCls} htmlFor="ma-year">Year</label>
                <input id="ma-year" name="year" type="number" min="0" max="2100" className={fieldCls}
                  defaultValue={draft?.year ?? undefined} />
              </div>
            </div>

            <div>
              <label className={labelCls} htmlFor="ma-category">Category</label>
              <select id="ma-category" name="category" defaultValue={draft?.category ?? "Technology"} className={fieldCls}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <div>
              <label className={labelCls} htmlFor="ma-abstract">Abstract / notes</label>
              <textarea id="ma-abstract" name="abstract" rows={3} className={fieldCls}
                defaultValue={draft?.abstract ?? ""} />
            </div>

            {state.ok === false && state.message && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{state.message}</p>
            )}
            <SubmitButton pendingLabel="Adding…">Add to catalogue</SubmitButton>
          </div>
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

  function download(filename: string, mime: string, body: string) {
    const blob = new Blob([body], { type: `${mime};charset=utf-8` });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function downloadCsvTemplate() {
    download("batch-template.csv", "text/csv", [
      "title,authors,venue,year,url,type,category,abstract",
      `"Jane's Defence Weekly — Indo-Pacific Naval Modernisation","Jane's editorial team","Jane's Defence Weekly",2025,https://customer.janes.com/display/JDW-0001,JOURNAL,Technology,"Regional naval build-up analysis."`,
      `"Jane's Land Warfare Platforms — Tracked Vehicles","Jane's editorial team","Jane's Land Warfare Platforms",2024,https://customer.janes.com/display/JLWP-0007,EBOOK,Technology,"Reference entry on tracked platforms."`,
    ].join("\n"));
  }

  function downloadMarcSample() {
    download("knovel-sample.marcxml", "application/xml", [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<collection xmlns="http://www.loc.gov/MARC21/slim">`,
      `  <record>`,
      `    <leader>02033nam a2200397 i 4500</leader>`,
      `    <controlfield tag="008">210101s2021    xxu           000 0 eng d</controlfield>`,
      `    <datafield tag="020" ind1=" " ind2=" "><subfield code="a">9780071842709 (electronic bk.)</subfield></datafield>`,
      `    <datafield tag="100" ind1="1" ind2=" "><subfield code="a">Green, Don W.,</subfield><subfield code="e">editor.</subfield></datafield>`,
      `    <datafield tag="245" ind1="1" ind2="0"><subfield code="a">Perry's Chemical Engineers' Handbook :</subfield><subfield code="b">ninth edition /</subfield><subfield code="c">Don W. Green, Marylee Z. Southard.</subfield></datafield>`,
      `    <datafield tag="264" ind1=" " ind2="1"><subfield code="a">New York :</subfield><subfield code="b">McGraw-Hill Education,</subfield><subfield code="c">2019.</subfield></datafield>`,
      `    <datafield tag="520" ind1=" " ind2=" "><subfield code="a">The definitive reference for chemical engineering, fully updated.</subfield></datafield>`,
      `    <datafield tag="650" ind1=" " ind2="0"><subfield code="a">Chemical engineering.</subfield></datafield>`,
      `    <datafield tag="856" ind1="4" ind2="0"><subfield code="u">https://app.knovel.com/kn/resources/kpPCEHE001/toc</subfield><subfield code="y">Full text via Knovel</subfield></datafield>`,
      `  </record>`,
      `</collection>`,
    ].join("\n"));
  }

  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Rows are streamed to the server in small chunks so the batch file itself
  // (parsed in the browser) never has to fit under any upload size limit.
  const CHUNK = 100;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.currentTarget);

    const rawProvider = String(fd.get("provider") ?? "");
    const chosenProvider =
      rawProvider === "__custom__" ? String(fd.get("customProvider") ?? "").trim() : rawProvider;
    const defaultType = String(fd.get("type") ?? "JOURNAL");
    const defaultCategory = String(fd.get("category") ?? "Technology");
    if (!chosenProvider) {
      setResult({ ok: false, message: "Choose or enter a provider for the batch." });
      return;
    }

    // Read the batch locally — the file is never uploaded, so size is unbounded.
    const file = fd.get("file");
    let text = "";
    let filename: string | undefined;
    if (file instanceof File && file.size > 0) {
      text = await file.text();
      filename = file.name;
    } else {
      text = String(fd.get("pasted") ?? "");
    }
    if (!text.trim()) {
      setResult({ ok: false, message: "Upload a file or paste records to import." });
      return;
    }

    setBusy(true);
    setResult(null);
    setProgress("Reading & parsing…");

    let rows: BulkRow[];
    let errors: string[];
    let format: string;
    try {
      const parsed = parseBulk(text, filename);
      ({ rows, errors, format } = parsed);
    } catch {
      setBusy(false);
      setProgress(null);
      setResult({ ok: false, message: "Could not parse the file — check it is valid CSV, JSON, XML, or MARCXML." });
      return;
    }
    if (rows.length === 0) {
      setBusy(false);
      setProgress(null);
      setResult({ ok: false, message: errors[0] ?? "No records found — check the file format." });
      return;
    }

    let imported = 0;
    let duplicates = 0;
    let skipped = 0;
    const skipReasons: string[] = [];
    let hardError: string | null = null;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      setProgress(`Importing ${Math.min(i + chunk.length, rows.length)} / ${rows.length}…`);
      const r = await importResourceRows(chunk, {
        provider: chosenProvider,
        defaultType,
        defaultCategory,
      });
      if (r.error) {
        hardError = r.error;
        break;
      }
      imported += r.imported;
      duplicates += r.duplicates;
      skipped += r.skipped;
      for (const s of r.skipReasons) if (skipReasons.length < 6) skipReasons.push(s);
    }

    setBusy(false);
    setProgress(null);

    if (hardError) {
      setResult({ ok: false, message: hardError });
      toast(hardError, false);
      return;
    }

    const parts = [`${imported} imported`];
    if (duplicates > 0) parts.push(`${duplicates} already in catalogue`);
    if (skipped > 0) parts.push(`${skipped} skipped`);
    let message = `${chosenProvider} batch (${format.toUpperCase()}): ${parts.join(" · ")}.`;
    const notes = [...errors, ...skipReasons];
    if (notes.length) message += ` — ${notes.slice(0, 6).join("; ")}`;
    const ok = imported > 0 || duplicates > 0;
    setResult({ ok, message });
    toast(message, ok);
  }

  return (
    <Card className="max-w-3xl p-5">
      <h2 className="font-display text-lg font-semibold">Bulk import a batch file</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Upload a whole batch — <strong>CSV, JSON, XML, or Knovel MARCXML</strong> — and every
        record is imported as a digital, link-out resource under the chosen provider.
        The file is parsed in your browser and streamed in, so there is <strong>no upload
        size limit</strong>. The format is auto-detected, fields are matched leniently, and
        each record is deduped against the catalogue.
      </p>
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
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
            <p className="mt-1 text-[11px] text-muted-foreground">MARCXML reads type from each record.</p>
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
            accept=".csv,.tsv,.json,.xml,.marcxml,.mrcx,text/csv,application/json,text/xml,application/xml"
            className={`${fieldCls} file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1 file:text-xs file:font-medium file:text-primary`} />
          <p className="mt-1 text-xs text-muted-foreground">
            CSV/JSON/XML fields (matched leniently): title, authors, url, year, venue, publisher, isbn, type, category, abstract.
            MARCXML maps 245/100/700/264/520/856/020 automatically.{" "}
            <button type="button" onClick={downloadCsvTemplate} className="text-primary hover:underline">
              CSV template
            </button>{" · "}
            <button type="button" onClick={downloadMarcSample} className="text-primary hover:underline">
              MARCXML sample
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

        {result && (
          <p className={`rounded-lg px-3 py-2 text-sm ${result.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>
            {result.message}
          </p>
        )}
        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy} className={`${buttonVariants.primary} ${busy ? "opacity-70" : ""}`}>
            {busy ? "Importing…" : "Import batch"}
          </button>
          {progress && <span className="text-xs text-muted-foreground">{progress}</span>}
        </div>
      </form>
    </Card>
  );
}
