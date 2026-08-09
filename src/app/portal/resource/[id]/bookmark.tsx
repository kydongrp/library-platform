"use client";

import { useState } from "react";
import { ActionButton } from "@/components/forms";
import { toggleBookmark } from "@/app/actions/engagement";

type FolderInfo = { id: string; name: string; contains: boolean };

/**
 * Save-to-favourites control: pick a collection (default "My Favourites",
 * created on first use) and toggle this title in/out of it.
 */
export function BookmarkButton({
  resourceId,
  folders,
}: {
  resourceId: string;
  folders: FolderInfo[];
}) {
  const [folderId, setFolderId] = useState(folders[0]?.id ?? "");
  const selected = folders.find((f) => f.id === folderId);
  const saved = selected?.contains ?? false;

  return (
    <div className="flex items-center gap-2">
      <ActionButton
        action={toggleBookmark}
        fields={{ resourceId, folderId }}
        variant={saved ? "accent" : "outline"}
        className="!px-3 !py-1.5 text-sm"
        pendingLabel="…"
      >
        {saved ? "♥ Saved" : "♡ Save"}
      </ActionButton>
      {folders.length > 1 && (
        <select
          value={folderId}
          onChange={(e) => setFolderId(e.target.value)}
          aria-label="Collection"
          className="rounded-lg border border-border bg-card px-2 py-1.5 text-xs"
        >
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} {f.contains ? "✓" : ""}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
