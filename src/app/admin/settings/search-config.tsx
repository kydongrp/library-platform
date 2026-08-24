"use client";

import { Card } from "@/components/ui";
import { StatefulForm, SubmitButton, ActionButton } from "@/components/forms";
import {
  addStopWord,
  removeStopWord,
  addVariantPair,
  removeVariantPair,
} from "@/app/actions/admin-settings";

const fieldCls =
  "rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

export function SearchConfigSection({
  stopWords,
  variants,
  readOnly,
}: {
  stopWords: { id: string; word: string }[];
  variants: { id: string; word: string; variant: string }[];
  readOnly: boolean;
}) {
  return (
    <div>
      <h2 className="mb-1 font-display text-xl font-semibold">Search configuration</h2>
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        Applies to the catalogue search here and to the Learner Portal API. Stop words are
        dropped from searches so clutter words never decide a match; variant spellings make a
        search for either form find both.
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h3 className="mb-1 font-display text-base font-semibold">
            Stop words ({stopWords.length})
          </h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Words dropped from search queries. A search made only of stop words falls back to
            plain matching.
          </p>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {stopWords.length === 0 && (
              <span className="text-xs text-muted-foreground">
                None, so every word in a search counts.
              </span>
            )}
            {stopWords.map((w) => (
              <span
                key={w.id}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 font-mono text-xs"
              >
                {w.word}
                {!readOnly && (
                  <ActionButton
                    action={removeStopWord}
                    fields={{ id: w.id }}
                    variant="ghost"
                    className="!p-0 !px-1 text-xs text-muted-foreground hover:text-red-700"
                    pendingLabel="…"
                  >
                    ✕
                  </ActionButton>
                )}
              </span>
            ))}
          </div>
          {!readOnly && (
            <StatefulForm action={addStopWord} className="flex items-center gap-2">
              <input
                name="word"
                placeholder="e.g. the"
                autoComplete="off"
                className={`${fieldCls} w-40 font-mono`}
              />
              <SubmitButton pendingLabel="…">Add</SubmitButton>
            </StatefulForm>
          )}
        </Card>

        <Card className="p-5">
          <h3 className="mb-1 font-display text-base font-semibold">
            Variant spellings ({variants.length})
          </h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Pairs expand in both directions, and chains connect: if colour ↔ color is listed,
            a search for either finds titles using the other.
          </p>
          <ul className="mb-3 divide-y divide-border">
            {variants.length === 0 && (
              <li className="py-1.5 text-xs text-muted-foreground">None yet.</li>
            )}
            {variants.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-2 py-1.5">
                <span className="font-mono text-xs">
                  {v.word} ↔ {v.variant}
                </span>
                {!readOnly && (
                  <ActionButton
                    action={removeVariantPair}
                    fields={{ id: v.id }}
                    variant="ghost"
                    className="!px-2 !py-0.5 text-xs text-red-700"
                    pendingLabel="…"
                  >
                    Remove
                  </ActionButton>
                )}
              </li>
            ))}
          </ul>
          {!readOnly && (
            <StatefulForm action={addVariantPair} className="flex flex-wrap items-center gap-2">
              <input name="word" placeholder="catalogue" autoComplete="off" className={`${fieldCls} w-36 font-mono`} />
              <span className="text-sm text-muted-foreground">↔</span>
              <input name="variant" placeholder="catalog" autoComplete="off" className={`${fieldCls} w-36 font-mono`} />
              <SubmitButton pendingLabel="…">Add pair</SubmitButton>
            </StatefulForm>
          )}
        </Card>
      </div>
    </div>
  );
}
