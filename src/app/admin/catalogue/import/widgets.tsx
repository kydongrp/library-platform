"use client";

import { useState } from "react";
import { StatefulForm, SubmitButton } from "@/components/forms";
import { importScholarly } from "@/app/actions/import";
import { CATEGORIES } from "@/lib/constants";
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
