"use client";

import { useState } from "react";
import { StatefulForm, SubmitButton, ActionButton } from "@/components/forms";
import { createFolder, deleteFolder, toggleBookmark } from "@/app/actions/engagement";

export function NewFolderForm() {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
      >
        + New collection
      </button>
    );
  }
  return (
    <StatefulForm action={createFolder} className="flex items-center gap-2">
      <input
        name="name"
        required
        autoFocus
        placeholder="Collection name"
        className="rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
      />
      <SubmitButton pendingLabel="Creating…">Create</SubmitButton>
      <button type="button" onClick={() => setOpen(false)} className="px-2 py-2 text-sm text-muted-foreground">
        Cancel
      </button>
    </StatefulForm>
  );
}

export function DeleteFolderButton({ folderId, name }: { folderId: string; name: string }) {
  return (
    <ActionButton
      action={deleteFolder}
      fields={{ folderId }}
      variant="ghost"
      className="!px-2 !py-1 text-xs text-red-600"
      confirm={`Delete "${name}" and everything in it?`}
      pendingLabel="…"
    >
      Delete collection
    </ActionButton>
  );
}

export function RemoveBookmarkButton({ folderId, resourceId }: { folderId: string; resourceId: string }) {
  return (
    <ActionButton
      action={toggleBookmark}
      fields={{ folderId, resourceId }}
      variant="ghost"
      className="!px-2 !py-1 text-xs text-muted-foreground"
      pendingLabel="…"
    >
      Remove
    </ActionButton>
  );
}
