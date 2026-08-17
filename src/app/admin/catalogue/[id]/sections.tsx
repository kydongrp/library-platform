"use client";

import { useState } from "react";
import { StatefulForm, SubmitButton, ActionButton } from "@/components/forms";
import { ResourceForm } from "@/components/resource-form";
import { Card } from "@/components/ui";
import { addCopies, updateResource } from "@/app/actions/catalogue";
import { saveMarcField, deleteMarcField } from "@/app/actions/marc";
import { parseSubfields, displayIndicator } from "@/lib/marc-tags";

export function AddCopiesForm({ resourceId }: { resourceId: string }) {
  return (
    <StatefulForm action={addCopies} className="flex items-center gap-2">
      <input type="hidden" name="resourceId" value={resourceId} />
      <input
        name="count"
        type="number"
        min="1"
        max="20"
        defaultValue={1}
        aria-label="Number of copies"
        className="w-16 rounded-lg border border-border bg-card px-2 py-1.5 text-sm"
      />
      <input
        name="location"
        defaultValue="Main Shelf"
        aria-label="Shelf location"
        className="w-32 rounded-lg border border-border bg-card px-2 py-1.5 text-sm"
      />
      <SubmitButton variant="outline" pendingLabel="Adding…">
        + Add copies
      </SubmitButton>
    </StatefulForm>
  );
}

type ResourceLike = {
  id: string;
  title: string;
  subtitle: string | null;
  author: string;
  isbn: string | null;
  type: string;
  // Carried through so the edit form shows a deliberate SERIAL override
  // instead of silently re-deriving it from the type.
  materialDesignation: string;
  category: string;
  publisher: string | null;
  publishedYear: number | null;
  description: string | null;
  coverColor: string;
  provider: string | null;
  digitalUrl: string | null;
};

export function EditResourceSection({ resource }: { resource: ResourceLike }) {
  return (
    <Card className="mb-6 p-5">
      <h2 className="mb-4 font-display text-lg font-semibold">Edit details</h2>
      <ResourceForm action={updateResource} defaults={resource} submitLabel="Save changes" />
    </Card>
  );
}

/* ---------- Full MARC cataloguing ---------- */

export type MarcFieldRow = {
  id: string;
  tag: string;
  ind1: string;
  ind2: string;
  value: string | null;
  subfields: unknown;
  seq: number;
};

export type TagDefRow = {
  tag: string;
  alias: string | null;
  label: string;
  description: string | null;
  repeatable: boolean;
  isControl: boolean;
  local: boolean;
  subfields: unknown;
};

const marcInput =
  "rounded-lg border border-border bg-card px-2 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

function parseSubfieldDefs(raw: unknown): { code: string; label: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is { code?: unknown; label?: unknown } => !!s && typeof s === "object")
    .map((s) => ({ code: String(s.code ?? ""), label: String(s.label ?? "") }))
    .filter((s) => s.code);
}

/** One editable field: tag, both indicators, and repeatable subfields. */
function MarcFieldEditor({
  resourceId,
  field,
  tagDefs,
  onDone,
}: {
  resourceId: string;
  field: MarcFieldRow | null;
  tagDefs: TagDefRow[];
  onDone: () => void;
}) {
  const [tag, setTag] = useState(field?.tag ?? "245");
  const def = tagDefs.find((d) => d.tag === tag);
  const isControl = def?.isControl ?? /^00\d$/.test(tag);
  const defSubs = parseSubfieldDefs(def?.subfields);

  const initial = parseSubfields(field?.subfields);
  const [subs, setSubs] = useState<{ code: string; value: string }[]>(
    initial.length ? initial : [{ code: "a", value: "" }],
  );

  return (
    <StatefulForm action={saveMarcField}>
      {(state) => (
        <div className="grid gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <input type="hidden" name="resourceId" value={resourceId} />
          {field && <input type="hidden" name="fieldId" value={field.id} />}

          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Tag</label>
              <input
                name="tag"
                value={tag}
                onChange={(e) => setTag(e.target.value.toUpperCase().slice(0, 3))}
                list="marc-tag-options"
                required
                className={`${marcInput} w-20 font-mono`}
              />
            </div>
            {!isControl && (
              <>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Ind 1</label>
                  <input name="ind1" defaultValue={field?.ind1 ?? " "} maxLength={1}
                    className={`${marcInput} w-12 text-center font-mono`} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Ind 2</label>
                  <input name="ind2" defaultValue={field?.ind2 ?? " "} maxLength={1}
                    className={`${marcInput} w-12 text-center font-mono`} />
                </div>
              </>
            )}
            <p className="pb-2 text-xs text-muted-foreground">
              {def
                ? `${def.label}${def.alias ? ` (${def.alias})` : ""}${def.repeatable ? " · repeatable" : ""}`
                : "Undefined tag — it will still be saved and exported."}
            </p>
          </div>

          {def?.description && <p className="text-xs text-muted-foreground">{def.description}</p>}

          {isControl ? (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Value</label>
              <input name="value" defaultValue={field?.value ?? ""}
                className={`${marcInput} w-full font-mono`} />
            </div>
          ) : (
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Subfields</span>
              {subs.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">$</span>
                  <input
                    name="sfCode"
                    value={s.code}
                    onChange={(e) => {
                      const v = e.target.value.slice(0, 1);
                      setSubs((p) => p.map((x, j) => (j === i ? { ...x, code: v } : x)));
                    }}
                    list={`sfdef-${tag}`}
                    className={`${marcInput} w-12 text-center font-mono`}
                  />
                  <input
                    name="sfValue"
                    value={s.value}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSubs((p) => p.map((x, j) => (j === i ? { ...x, value: v } : x)));
                    }}
                    placeholder={defSubs.find((d) => d.code === s.code)?.label ?? "value"}
                    className={`${marcInput} flex-1`}
                  />
                  <button type="button" aria-label="Remove subfield"
                    onClick={() => setSubs((p) => p.filter((_, j) => j !== i))}
                    className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted">
                    ✕
                  </button>
                </div>
              ))}
              <datalist id={`sfdef-${tag}`}>
                {defSubs.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}
              </datalist>
              <div>
                <button type="button"
                  onClick={() => setSubs((p) => [...p, { code: defSubs[p.length]?.code ?? "a", value: "" }])}
                  className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-muted">
                  ＋ Subfield
                </button>
              </div>
            </div>
          )}

          {state.ok === false && state.message && (
            <p className="text-sm text-red-700">{state.message}</p>
          )}
          <div className="flex items-center gap-2">
            <SubmitButton pendingLabel="Saving…" className="!px-3 !py-1.5 text-xs">
              {field ? "Save field" : "Add field"}
            </SubmitButton>
            <button type="button" onClick={onDone}
              className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
              Cancel
            </button>
          </div>
        </div>
      )}
    </StatefulForm>
  );
}

export function MarcRecordSection({
  resourceId,
  fields,
  tagDefs,
}: {
  resourceId: string;
  fields: MarcFieldRow[];
  tagDefs: TagDefRow[];
}) {
  const [editing, setEditing] = useState<string | null>(null); // field id, or "new"

  return (
    <Card className="mb-6 p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold">MARC record</h2>
        {editing !== "new" && (
          <button onClick={() => setEditing("new")}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted">
            ＋ Add field
          </button>
        )}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Full cataloguing. Fields entered here take precedence when the record is
        exported: a tag you catalogue replaces its derived equivalent, and tags
        you leave alone keep theirs. Repeatable tags may appear as often as needed.
      </p>

      <datalist id="marc-tag-options">
        {tagDefs.map((d) => (
          <option key={d.tag} value={d.tag}>
            {d.label}{d.alias ? ` (${d.alias})` : ""}
          </option>
        ))}
      </datalist>

      {editing === "new" && (
        <div className="mb-3">
          <MarcFieldEditor resourceId={resourceId} field={null} tagDefs={tagDefs}
            onDone={() => setEditing(null)} />
        </div>
      )}

      {fields.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">
          No catalogued fields yet. Export still works — MARC is derived from the
          details above until you add fields here.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {fields.map((f) => {
            const def = tagDefs.find((d) => d.tag === f.tag);
            const subs = parseSubfields(f.subfields);
            return (
              <li key={f.id} className="py-2">
                {editing === f.id ? (
                  <MarcFieldEditor resourceId={resourceId} field={f} tagDefs={tagDefs}
                    onDone={() => setEditing(null)} />
                ) : (
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-sm">
                        <span className="font-semibold">{f.tag}</span>
                        {!f.value && (
                          <span className="ml-1 text-muted-foreground">
                            {displayIndicator(f.ind1)}{displayIndicator(f.ind2)}
                          </span>
                        )}
                        <span className="ml-2">
                          {f.value ??
                            subs.map((s, i) => (
                              <span key={i}>
                                <span className="text-primary">${s.code}</span> {s.value}{" "}
                              </span>
                            ))}
                        </span>
                      </p>
                      {def && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {def.label}{def.local ? " · local" : ""}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => setEditing(f.id)}
                        className="rounded px-2 py-1 text-xs text-primary hover:bg-muted">
                        Edit
                      </button>
                      <ActionButton action={deleteMarcField} fields={{ fieldId: f.id }}
                        variant="ghost" className="!px-2 !py-1 text-xs text-red-700" pendingLabel="…"
                        confirm={`Remove field ${f.tag} from this record?`}>
                        Remove
                      </ActionButton>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
