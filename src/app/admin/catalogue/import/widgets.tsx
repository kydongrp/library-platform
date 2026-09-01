"use client";

import { useState, type FormEvent } from "react";
import { StatefulForm, SubmitButton } from "@/components/forms";
import { Card, buttonVariants } from "@/components/ui";
import { importScholarly, addManualArticle, importResourceRows, draftArticle } from "@/app/actions/import";
import type { ArticleDraft } from "@/lib/ai-draft";
import { useToast } from "@/components/toast";
import {
  RESOURCE_TYPES,
  RESOURCE_TYPE_LABELS,
  PROVIDERS,
  PROVIDER_GROUPS,
} from "@/lib/constants";
import { parseBulk, parseBulkBinary, chunkRows, type BulkRow } from "@/lib/bulk-import";
import type { ScholarlyRecord } from "@/lib/scholarly";

/** Provider name the forms start on. See PROVIDER_GROUPS for why it is first. */
const DEFAULT_PROVIDER = PROVIDERS[0] ?? "";

/**
 * Options for a provider <select>, grouped by kind.
 *
 * Grouped rather than flat because the list is long enough that a single run of
 * forty names is hard to scan. Callers add their own "Other…" option after this.
 */
function ProviderOptions() {
  return PROVIDER_GROUPS.map((group) => (
    <optgroup key={group.label} label={group.label}>
      {group.providers.map((p) => (
        <option key={p} value={p}>
          {p}
        </option>
      ))}
    </optgroup>
  ));
}

/**
 * Per-row import.
 *
 * No category picker: importing is about getting records IN, and classifying
 * them one at a time at the point of import was slow and usually wrong, since
 * the person importing a batch is rarely the person who decides its subject.
 * Everything lands as Uncategorised and is classified afterwards from the
 * catalogue, which can filter for exactly those records.
 */
export function ImportButton({ record }: { record: ScholarlyRecord }) {
  return (
    <StatefulForm action={importScholarly} className="flex items-center gap-2">
      <input type="hidden" name="records" value={JSON.stringify(record)} />
      <SubmitButton variant="outline" className="!px-3 !py-1.5 text-xs" pendingLabel="Importing…">
        ⇩ Import
      </SubmitButton>
    </StatefulForm>
  );
}

/** Bulk import bar: import every not-yet-imported result on the page. */
export function ImportAllBar({ records, count }: { records: ScholarlyRecord[]; count: number }) {
  return (
    <StatefulForm
      action={importScholarly}
      className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3"
    >
      <input type="hidden" name="records" value={JSON.stringify(records)} />
      <p className="text-sm">
        <span className="font-medium">{count}</span> new record{count === 1 ? "" : "s"} on this page
      </p>
      <div className="ml-auto flex items-center gap-2">
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
export function ManualArticleForm({ aiEnabled }: { aiEnabled: boolean }) {
  const [provider, setProvider] = useState(DEFAULT_PROVIDER);
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
          review. Nothing is saved until you check the fields and click Add.
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
                  <ProviderOptions />
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
                placeholder="e.g. Jane's Defence Weekly: Naval Systems Assessment" />
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
export function BulkImportForm() {
  // Bulk import starts on Janes rather than the global default: a whole file at
  // once is how the no-API providers get loaded, and Janes is the usual one.
  const [provider, setProvider] = useState(
    PROVIDERS.includes("Janes") ? "Janes" : DEFAULT_PROVIDER,
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
      "title,authors,venue,year,url,type,abstract",
      `"Jane's Defence Weekly: Indo-Pacific Naval Modernisation","Jane's editorial team","Jane's Defence Weekly",2025,https://customer.janes.com/display/JDW-0001,JOURNAL,"Regional naval build-up analysis."`,
      `"Jane's Land Warfare Platforms: Tracked Vehicles","Jane's editorial team","Jane's Land Warfare Platforms",2024,https://customer.janes.com/display/JLWP-0007,EBOOK,"Reference entry on tracked platforms."`,
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
  // chunkRows bounds each call by bytes as well as by row count, because a row
  // now carries the source record's MARC and a hundred fat records overrun the
  // Server Action body limit.

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.currentTarget);

    const rawProvider = String(fd.get("provider") ?? "");
    const chosenProvider =
      rawProvider === "__custom__" ? String(fd.get("customProvider") ?? "").trim() : rawProvider;
    const defaultType = String(fd.get("type") ?? "JOURNAL");
    if (!chosenProvider) {
      setResult({ ok: false, message: "Choose or enter a provider for the batch." });
      return;
    }

    // Read the batch locally: the file is never uploaded, so size is unbounded.
    const file = fd.get("file");
    let text = "";
    let filename: string | undefined;
    // A .mrc file is binary ISO 2709: it stores byte offsets and frames data
    // with control bytes, so decoding it to text shifts every offset and the
    // records fall apart. Those are read as bytes instead.
    let bytes: Uint8Array | null = null;
    if (file instanceof File && file.size > 0) {
      filename = file.name;
      if (/\.(mrc|marc|mrc8)$/i.test(file.name)) {
        bytes = new Uint8Array(await file.arrayBuffer());
      } else {
        text = await file.text();
      }
    } else {
      text = String(fd.get("pasted") ?? "");
    }
    if (!bytes && !text.trim()) {
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
      const parsed = bytes ? parseBulkBinary(bytes) : parseBulk(text, filename);
      ({ rows, errors, format } = parsed);
    } catch {
      setBusy(false);
      setProgress(null);
      setResult({
        ok: false,
        message: "Could not parse the file. Check it is valid CSV, JSON, XML, MARCXML, or binary MARC (.mrc).",
      });
      return;
    }
    if (rows.length === 0) {
      setBusy(false);
      setProgress(null);
      setResult({ ok: false, message: errors[0] ?? "No records found. Check the file format." });
      return;
    }

    let imported = 0;
    let duplicates = 0;
    let skipped = 0;
    let marcRecords = 0;
    let marcFields = 0;
    const skipReasons: string[] = [];
    let hardError: string | null = null;
    let done = 0;
    for (const chunk of chunkRows(rows)) {
      done += chunk.length;
      setProgress(`Importing ${done} / ${rows.length}…`);
      let r: Awaited<ReturnType<typeof importResourceRows>>;
      try {
        r = await importResourceRows(chunk, {
          provider: chosenProvider,
          defaultType,
        });
      } catch (e) {
        // Without this the rejection escapes handleSubmit, so setBusy(false)
        // below never runs: the button stays disabled, the progress text
        // freezes mid-count, and nothing says that the chunks already sent did
        // land. Say what got in before reporting the failure.
        hardError =
          `The import stopped after ${imported} record${imported === 1 ? "" : "s"}. ` +
          `${e instanceof Error ? e.message : "The server rejected the batch."} ` +
          "Those records are in the catalogue; re-running the same file will add the rest and skip them.";
        break;
      }
      if (r.error) {
        hardError = r.error;
        break;
      }
      imported += r.imported;
      duplicates += r.duplicates;
      skipped += r.skipped;
      marcRecords += r.marcRecords;
      marcFields += r.marcFields;
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
    // Reported separately from the import count because the two do not have to
    // move together. Re-uploading a file whose records are all already here
    // imports nothing and still catalogues every one of them, which is exactly
    // how a batch loaded before the importer kept MARC gets its MARC.
    if (marcRecords > 0)
      parts.push(`${marcRecords} catalogued from the file's MARC (${marcFields} fields)`);
    let message = `${chosenProvider} batch (${format.toUpperCase()}): ${parts.join(" · ")}.`;
    const notes = [...errors, ...skipReasons];
    if (notes.length) message += ` Notes: ${notes.slice(0, 6).join("; ")}`;
    const ok = imported > 0 || duplicates > 0;
    setResult({ ok, message });
    toast(message, ok);
  }

  return (
    <Card className="max-w-3xl p-5">
      <h2 className="font-display text-lg font-semibold">Bulk import a batch file</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Upload a whole batch (<strong>CSV, JSON, XML, or Knovel MARCXML</strong>) and every
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
              <ProviderOptions />
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
        </div>

        <div>
          <label className={labelCls} htmlFor="bi-file">Batch file</label>
          <input id="bi-file" name="file" type="file"
            accept=".csv,.tsv,.json,.xml,.marcxml,.mrcx,.mrc,.marc,text/csv,application/json,text/xml,application/xml,application/marc"
            className={`${fieldCls} file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1 file:text-xs file:font-medium file:text-primary`} />
          <p className="mt-1 text-xs text-muted-foreground">
            CSV/JSON/XML fields (matched leniently): title, authors, url, year, venue, publisher, isbn, type, abstract.
            MARCXML and binary MARC21 (.mrc) map 245/100/700/264/520/856/020 automatically.{" "}
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
