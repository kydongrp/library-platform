"use client";

import { useActionState, useState } from "react";
import { idleState } from "@/lib/types";
import { uploadCoverImages } from "@/app/actions/covers";
import { SubmitButton } from "@/components/forms";
import { tokenFromFileName, describeToken, GENERAL_TOKENS } from "@/lib/cover-match";

/**
 * Upload form for the common-cover pool.
 *
 * The file name IS the rule, so the form tells staff what each chosen file will
 * match BEFORE they upload it. Getting that wrong is otherwise invisible until
 * an import quietly puts a general cover on a Defence record, and a preview is
 * cheaper than a support conversation.
 *
 * cover-match.ts is pure and client-safe precisely so this preview can use the
 * same function the server will, rather than a second implementation that can
 * drift from it.
 */
export function CoverUploadForm({
  collections,
  publishers,
}: {
  collections: string[];
  publishers: string[];
}) {
  const [state, action] = useActionState(uploadCoverImages, idleState);
  const [chosen, setChosen] = useState<string[]>([]);

  const previews = chosen.map((name) => {
    const token = tokenFromFileName(name);
    const { scope, matches } = describeToken(token, { collections, publishers });
    return { name, token, scope, matches };
  });

  return (
    <form action={action} className="space-y-3">
      <div>
        <label htmlFor="cover-files" className="block text-sm font-medium">
          Images
        </label>
        <input
          id="cover-files"
          name="files"
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(e) => setChosen(Array.from(e.target.files ?? []).map((f) => f.name))}
          className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm"
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          PNG, JPEG, WebP or GIF. Up to 12 files and 1.2MB each per upload. Name each file after the
          collection or publisher it serves, with an optional number:{" "}
          <code className="rounded bg-muted px-1">Defence-01.png</code>,{" "}
          <code className="rounded bg-muted px-1">IEEE Xplore 2.jpg</code>, or{" "}
          <code className="rounded bg-muted px-1">general-1.png</code> for anything.
        </p>
      </div>

      {previews.length > 0 && (
        <div className="rounded-md border border-border bg-muted/40 p-3">
          <p className="mb-2 text-xs font-medium">What these file names will match</p>
          <ul className="space-y-1 text-xs">
            {previews.map((p) => (
              <li key={p.name} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{p.name}</span>
                <span className="text-muted-foreground">token &quot;{p.token || "(none)"}&quot;</span>
                {p.scope === "general" && (
                  <span className="text-amber-700">
                    general: used only when nothing more specific matches
                  </span>
                )}
                {p.scope === "unused" && (
                  <span className="text-red-700">
                    matches nothing, so it would never be assigned
                  </span>
                )}
                {(p.scope === "collection" || p.scope === "publisher") && (
                  <span className="text-teal-800">
                    {p.scope}: {p.matches}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {previews.some((p) => p.scope === "unused") && (
            <p className="mt-2 text-xs text-red-700">
              A name that matches no collection or publisher, and is not one of the general names
              ({GENERAL_TOKENS.join(", ")}), would never be assigned to anything. Check the spelling
              against the lists on this page, or rename the file to a general one.
            </p>
          )}
        </div>
      )}

      <SubmitButton pendingLabel="Uploading…">Upload</SubmitButton>
      {state.message && (
        <p className={`text-sm ${state.ok ? "text-green-700" : "text-red-700"}`}>{state.message}</p>
      )}
    </form>
  );
}
