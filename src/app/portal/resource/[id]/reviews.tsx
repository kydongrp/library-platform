"use client";

import { useState } from "react";
import { StatefulForm, SubmitButton, ActionButton } from "@/components/forms";
import { Card } from "@/components/ui";
import { saveReview, deleteReview } from "@/app/actions/engagement";

/** Interactive 1–5 star picker backed by a hidden input. */
function StarPicker({ initial }: { initial: number }) {
  const [value, setValue] = useState(initial);
  const [hover, setHover] = useState(0);
  return (
    <div className="flex items-center gap-1">
      <input type="hidden" name="rating" value={value} />
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => setValue(n)}
          onMouseEnter={() => setHover(n)}
          onMouseLeave={() => setHover(0)}
          aria-label={`${n} star${n === 1 ? "" : "s"}`}
          className={`text-2xl leading-none transition-colors ${
            n <= (hover || value) ? "text-amber-500" : "text-stone-300"
          }`}
        >
          ★
        </button>
      ))}
      {value > 0 && <span className="ml-1 text-sm text-muted-foreground">{value}/5</span>}
    </div>
  );
}

export function ReviewForm({
  resourceId,
  existing,
}: {
  resourceId: string;
  existing: { id: string; rating: number; text: string | null } | null;
}) {
  return (
    <Card className="p-4">
      <h3 className="mb-2 font-display text-base font-semibold">
        {existing ? "Your review" : "Write a review"}
      </h3>
      <StatefulForm action={saveReview} className="space-y-3">
        <input type="hidden" name="resourceId" value={resourceId} />
        <StarPicker initial={existing?.rating ?? 0} />
        <textarea
          name="text"
          rows={3}
          defaultValue={existing?.text ?? ""}
          placeholder="What did you think? (optional)"
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
        <div className="flex items-center gap-2">
          <SubmitButton pendingLabel="Saving…">{existing ? "Update review" : "Post review"}</SubmitButton>
          {existing && (
            <ActionButton
              action={deleteReview}
              fields={{ reviewId: existing.id }}
              variant="ghost"
              className="text-xs text-red-600"
              confirm="Delete your review?"
              pendingLabel="…"
            >
              Delete
            </ActionButton>
          )}
        </div>
      </StatefulForm>
    </Card>
  );
}
