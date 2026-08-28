"use client";

import { useState, useTransition } from "react";
import { createResourceCategory } from "@/app/actions/catalogue";
import { useToast } from "@/components/toast";

/**
 * Add an Area of Interest without leaving the record being catalogued.
 *
 * This sits INSIDE the resource form, so it cannot be a <form> of its own:
 * nested forms are invalid HTML and the browser drops the inner one, which
 * would silently submit the whole record instead of adding a category. So the
 * control is a plain button that calls the server action directly, and its text
 * input carries no `name` attribute so it is never posted with the record.
 *
 * The new category is selected immediately on success, because the reason you
 * are adding one is that you want to use it now.
 */
export function CategoryAdder({
  onAdded,
}: {
  /** Called with the new name so the parent can select it. */
  onAdded: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  function submit() {
    const value = name.trim();
    if (!value || pending) return;
    startTransition(async () => {
      const fd = new FormData();
      fd.set("name", value);
      const result = await createResourceCategory({}, fd);
      toast(result.message ?? "", result.ok ?? false);
      if (result.ok) {
        onAdded(value);
        setName("");
        setOpen(false);
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1.5 text-xs font-medium text-primary hover:underline"
      >
        + Add a category
      </button>
    );
  }

  return (
    <div className="mt-1.5 flex items-center gap-2">
      <input
        // Deliberately no name attribute: this input lives inside the resource
        // form and must not be submitted with it.
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // Otherwise Enter submits the surrounding resource form.
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") setOpen(false);
        }}
        maxLength={60}
        autoFocus
        placeholder="New category name"
        aria-label="New category name"
        className="w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
      />
      <button
        type="button"
        onClick={submit}
        disabled={pending || !name.trim()}
        className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
      >
        {pending ? "Adding…" : "Add"}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-muted"
      >
        Cancel
      </button>
    </div>
  );
}
