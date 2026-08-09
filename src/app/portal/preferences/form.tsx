"use client";

import { useState } from "react";
import { StatefulForm, SubmitButton } from "@/components/forms";
import { saveInterests } from "@/app/actions/engagement";

export function InterestsForm({ all, selected }: { all: string[]; selected: string[] }) {
  const [picked, setPicked] = useState(new Set(selected));

  const toggle = (c: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  return (
    <StatefulForm action={saveInterests}>
      <div className="flex flex-wrap gap-2">
        {all.map((c) => {
          const on = picked.has(c);
          return (
            <button
              key={c}
              type="button"
              onClick={() => toggle(c)}
              aria-pressed={on}
              className={`rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                on
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-stone-600 hover:border-primary hover:text-primary"
              }`}
            >
              {on ? "✓ " : ""}{c}
            </button>
          );
        })}
      </div>
      {[...picked].map((c) => (
        <input key={c} type="hidden" name="interests" value={c} />
      ))}
      <div className="mt-5">
        <SubmitButton pendingLabel="Saving…">Save preferences</SubmitButton>
      </div>
    </StatefulForm>
  );
}
