"use client";

import { useState } from "react";
import { StatefulForm, SubmitButton } from "@/components/forms";
import {
  createCollection, createLocation, createItemType,
  changeItemProperties, weedItems,
} from "@/app/actions/items";
import { COPY_STATUSES, COPY_STATUS_LABELS } from "@/lib/constants";

const fieldCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelCls = "mb-1 block text-xs font-medium text-muted-foreground";

export type CodeOption = { id: string; code: string; name: string };

function Err({ state }: { state: { ok?: boolean; message?: string } }) {
  return state.ok === false && state.message ? (
    <p className="text-sm text-red-700">{state.message}</p>
  ) : null;
}

export function CollectionForm() {
  return (
    <StatefulForm action={createCollection}>
      {(state) => (
        <div className="grid grid-cols-[6rem_1fr_6rem_auto] items-end gap-2">
          <div>
            <label className={labelCls}>Code</label>
            <input name="code" required maxLength={24} placeholder="REF" className={fieldCls} />
          </div>
          <div>
            <label className={labelCls}>Name</label>
            <input name="name" required maxLength={80} placeholder="Reference" className={fieldCls} />
          </div>
          <div>
            <label className={labelCls}>Loan cap</label>
            <input name="loanLimitOverride" inputMode="numeric" placeholder="—" className={fieldCls} />
          </div>
          <SubmitButton pendingLabel="…" variant="outline">Add</SubmitButton>
          <div className="col-span-4"><Err state={state} /></div>
        </div>
      )}
    </StatefulForm>
  );
}

export function LocationForm() {
  return (
    <StatefulForm action={createLocation}>
      {(state) => (
        <div className="grid grid-cols-[6rem_1fr_auto] items-end gap-2">
          <div>
            <label className={labelCls}>Code</label>
            <input name="code" required maxLength={24} placeholder="L2" className={fieldCls} />
          </div>
          <div>
            <label className={labelCls}>Name</label>
            <input name="name" required maxLength={80} placeholder="Level 2 Reading Room" className={fieldCls} />
          </div>
          <SubmitButton pendingLabel="…" variant="outline">Add</SubmitButton>
          <div className="col-span-3"><Err state={state} /></div>
        </div>
      )}
    </StatefulForm>
  );
}

export function ItemTypeForm() {
  return (
    <StatefulForm action={createItemType}>
      {(state) => (
        <div className="grid grid-cols-[6rem_1fr_5.5rem_auto_auto] items-end gap-2">
          <div>
            <label className={labelCls}>Code</label>
            <input name="code" required maxLength={24} placeholder="AV" className={fieldCls} />
          </div>
          <div>
            <label className={labelCls}>Name</label>
            <input name="name" required maxLength={80} placeholder="Audio-visual" className={fieldCls} />
          </div>
          <div>
            {/* Row 56: set this and the type circulates by the hour. */}
            <label className={labelCls}>Loan hours</label>
            <input name="loanHours" type="number" min={1} max={720} placeholder="—" className={fieldCls} />
          </div>
          <label className="flex items-center gap-1.5 pb-2 text-sm">
            <input type="checkbox" name="loanable" defaultChecked
              className="h-4 w-4 rounded border-border accent-primary" />
            Loanable
          </label>
          <SubmitButton pendingLabel="…" variant="outline">Add</SubmitButton>
          <div className="col-span-5">
            <Err state={state} />
            <p className="mt-1 text-xs text-muted-foreground">
              Leave loan hours blank for the usual day-based policy. Set it (for
              example 4) to circulate equipment by the hour.
            </p>
          </div>
        </div>
      )}
    </StatefulForm>
  );
}

/**
 * Items table with row selection driving the two batch operations. Selection
 * is client state; the chosen ids ride along as a hidden field.
 */
export function ItemsTable({
  items,
  collections,
  locations,
  itemTypes,
  editable,
}: {
  items: {
    id: string; barcode: string; title: string; resourceId: string;
    status: string; collection: string | null; location: string | null;
    itemType: string | null; onLoanTo: string | null;
  }[];
  collections: CodeOption[];
  locations: CodeOption[];
  itemTypes: CodeOption[];
  editable: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const allShown = items.length > 0 && items.every((i) => selected.has(i.id));
  const ids = [...selected].join(",");

  return (
    <>
      {editable && selected.size > 0 && (
        <div className="mb-3 grid gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
          <p className="text-sm font-medium">
            {selected.size} item{selected.size === 1 ? "" : "s"} selected
          </p>

          <StatefulForm action={changeItemProperties}>
            {(state) => (
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto] sm:items-end">
                <input type="hidden" name="copyIds" value={ids} />
                <div>
                  <label className={labelCls}>Collection</label>
                  <select name="collectionId" defaultValue="" className={fieldCls}>
                    <option value="">leave as is</option>
                    <option value="__clear__">— clear —</option>
                    {collections.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Location</label>
                  <select name="locationId" defaultValue="" className={fieldCls}>
                    <option value="">leave as is</option>
                    <option value="__clear__">— clear —</option>
                    {locations.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Item type</label>
                  <select name="itemTypeId" defaultValue="" className={fieldCls}>
                    <option value="">leave as is</option>
                    <option value="__clear__">— clear —</option>
                    {itemTypes.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Status</label>
                  <select name="status" defaultValue="" className={fieldCls}>
                    <option value="">leave as is</option>
                    {COPY_STATUSES.filter((s) => s !== "ON_LOAN").map((s) => (
                      <option key={s} value={s}>{COPY_STATUS_LABELS[s]}</option>
                    ))}
                  </select>
                </div>
                <SubmitButton pendingLabel="Applying…">Apply</SubmitButton>
                <div className="sm:col-span-5"><Err state={state} /></div>
              </div>
            )}
          </StatefulForm>

          <StatefulForm action={weedItems}>
            {(state) => (
              <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                <input type="hidden" name="copyIds" value={ids} />
                <div>
                  <label className={labelCls}>Weed these items — reason (recorded in the log)</label>
                  <input name="reason" required maxLength={200}
                    placeholder="e.g. Superseded edition, withdrawn 2026 stocktake" className={fieldCls} />
                </div>
                <SubmitButton pendingLabel="Weeding…" variant="danger">✕ Weed selected</SubmitButton>
                <div className="sm:col-span-2"><Err state={state} /></div>
              </div>
            )}
          </StatefulForm>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              {editable && (
                <th className="px-3 py-2.5">
                  <input
                    type="checkbox"
                    aria-label="Select all shown"
                    checked={allShown}
                    onChange={() => setSelected(allShown ? new Set() : new Set(items.map((i) => i.id)))}
                    className="h-4 w-4 rounded border-border accent-primary"
                  />
                </th>
              )}
              <th className="px-3 py-2.5 font-medium">Barcode</th>
              <th className="px-3 py-2.5 font-medium">Title</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5 font-medium">Collection</th>
              <th className="px-3 py-2.5 font-medium">Location</th>
              <th className="px-3 py-2.5 font-medium">Type</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} className="border-b border-border last:border-0">
                {editable && (
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Select ${i.barcode}`}
                      checked={selected.has(i.id)}
                      onChange={() => toggle(i.id)}
                      className="h-4 w-4 rounded border-border accent-primary"
                    />
                  </td>
                )}
                <td className="px-3 py-2 font-mono text-xs">{i.barcode}</td>
                <td className="px-3 py-2">
                  <a href={`/admin/catalogue/${i.resourceId}`} className="hover:underline">{i.title}</a>
                  {i.onLoanTo && (
                    <span className="block text-xs text-muted-foreground">on loan to {i.onLoanTo}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">{COPY_STATUS_LABELS[i.status] ?? i.status}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{i.collection ?? "—"}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{i.location ?? "—"}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{i.itemType ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
