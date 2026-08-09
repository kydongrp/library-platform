"use client";

import { useState } from "react";
import { StatefulForm, SubmitButton } from "@/components/forms";
import { BookCover, Card } from "@/components/ui";
import {
  CATEGORIES,
  RESOURCE_TYPES,
  RESOURCE_TYPE_LABELS,
  DIGITAL_TYPES,
  PROVIDERS,
} from "@/lib/constants";
import type { ActionState } from "@/lib/types";

const COLORS = [
  "#0f766e", "#1e3a8a", "#9a3412", "#374151", "#b45309",
  "#7c2d12", "#065f46", "#312e81", "#be123c", "#a21caf",
  "#0e7490", "#15803d", "#92400e", "#155e75", "#6d28d9",
];

type Defaults = {
  id?: string;
  title?: string;
  subtitle?: string | null;
  author?: string;
  isbn?: string | null;
  type?: string;
  category?: string;
  publisher?: string | null;
  publishedYear?: number | null;
  description?: string | null;
  coverColor?: string;
  provider?: string | null;
  digitalUrl?: string | null;
  editorsPick?: boolean;
};

const labelCls = "block text-sm font-medium text-foreground mb-1.5";
const inputCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

export function ResourceForm({
  action,
  defaults = {},
  submitLabel = "Save",
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  defaults?: Defaults;
  submitLabel?: string;
}) {
  const [title, setTitle] = useState(defaults.title ?? "");
  const [author, setAuthor] = useState(defaults.author ?? "");
  const [type, setType] = useState(defaults.type ?? "BOOK");
  const [color, setColor] = useState(defaults.coverColor ?? COLORS[0]);
  const [provider, setProvider] = useState(defaults.provider ?? "");
  // External-provider or digital-format titles are accessed online, no copies.
  const isDigital = DIGITAL_TYPES.has(type) || provider.trim() !== "";

  return (
    <StatefulForm action={action}>
      {(state) => (
        <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
          {/* Fields */}
          <div className="space-y-4">
            {defaults.id && <input type="hidden" name="id" value={defaults.id} />}

            <div>
              <label className={labelCls} htmlFor="title">Title *</label>
              <input id="title" name="title" required value={title}
                onChange={(e) => setTitle(e.target.value)} className={inputCls} />
            </div>

            <div>
              <label className={labelCls} htmlFor="subtitle">Subtitle</label>
              <input id="subtitle" name="subtitle" defaultValue={defaults.subtitle ?? ""} className={inputCls} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="author">Author *</label>
                <input id="author" name="author" required value={author}
                  onChange={(e) => setAuthor(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls} htmlFor="isbn">ISBN</label>
                <input id="isbn" name="isbn" defaultValue={defaults.isbn ?? ""} className={inputCls} />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="type">Type</label>
                <select id="type" name="type" value={type}
                  onChange={(e) => setType(e.target.value)} className={inputCls}>
                  {RESOURCE_TYPES.map((t) => (
                    <option key={t} value={t}>{RESOURCE_TYPE_LABELS[t]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls} htmlFor="category">Category</label>
                <select id="category" name="category" defaultValue={defaults.category ?? "Technology"} className={inputCls}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="publisher">Publisher</label>
                <input id="publisher" name="publisher" defaultValue={defaults.publisher ?? ""} className={inputCls} />
              </div>
              <div>
                <label className={labelCls} htmlFor="publishedYear">Published year</label>
                <input id="publishedYear" name="publishedYear" type="number" min="0" max="2100"
                  defaultValue={defaults.publishedYear ?? ""} className={inputCls} />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="provider">
                  External provider <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <input id="provider" name="provider" list="provider-options" value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  placeholder="e.g. IEEE Xplore — blank for local collection" className={inputCls} />
                <datalist id="provider-options">
                  {PROVIDERS.map((p) => <option key={p} value={p} />)}
                </datalist>
              </div>
              <div>
                <label className={labelCls} htmlFor="digitalUrl">Access URL</label>
                <input id="digitalUrl" name="digitalUrl" type="url" defaultValue={defaults.digitalUrl ?? ""}
                  placeholder="https://ieeexplore.ieee.org/document/…" className={inputCls} />
              </div>
            </div>

            <div>
              <label className={labelCls} htmlFor="description">Description</label>
              <textarea id="description" name="description" rows={4}
                defaultValue={defaults.description ?? ""} className={inputCls} />
            </div>

            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" name="editorsPick" defaultChecked={defaults.editorsPick ?? false}
                className="h-4 w-4 rounded border-border accent-[var(--primary)]" />
              Editor&apos;s Pick — feature on the Learner Portal homepage
            </label>

            {!defaults.id && (
              <div>
                <label className={labelCls} htmlFor="copyCount">
                  Initial copies {isDigital && "(digital titles need none)"}
                </label>
                <input id="copyCount" name="copyCount" type="number" min="0" max="50"
                  defaultValue={isDigital ? 0 : 2} disabled={isDigital}
                  className={`${inputCls} disabled:bg-muted disabled:text-muted-foreground`} />
              </div>
            )}

            {state.ok === false && state.message && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{state.message}</p>
            )}

            <div className="flex gap-3 pt-1">
              <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
            </div>
          </div>

          {/* Live preview */}
          <div>
            <p className={labelCls}>Cover preview</p>
            <Card className="flex flex-col items-center gap-4 p-5">
              <BookCover title={title || "Untitled"} author={author || "Unknown author"} color={color} type={type} size="lg" />
              <input type="hidden" name="coverColor" value={color} />
              <div className="flex flex-wrap justify-center gap-1.5">
                {COLORS.map((c) => (
                  <button key={c} type="button" onClick={() => setColor(c)}
                    aria-label={`Use ${c}`}
                    className={`h-6 w-6 rounded-full ring-2 ring-offset-1 transition ${color === c ? "ring-foreground" : "ring-transparent"}`}
                    style={{ background: c }} />
                ))}
              </div>
            </Card>
          </div>
        </div>
      )}
    </StatefulForm>
  );
}
