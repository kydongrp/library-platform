"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { idleState } from "@/lib/types";
import { uploadCoverImages } from "@/app/actions/covers";
import { SubmitButton } from "@/components/forms";
import { tokenFromFileName, describeToken, GENERAL_TOKENS } from "@/lib/cover-match";

const ZOOMS = [1, 2, 4] as const;

/**
 * A cover thumbnail that opens full size, and zooms.
 *
 * The list shows every image at 40 by 56 pixels, which is enough to tell one
 * apart from another and not enough to check one. Whether the type is legible,
 * whether a supplier's artwork is the right way up, whether a scan is clean:
 * none of that is answerable at thumbnail size, and the alternative was
 * downloading the file to look at it.
 *
 * A native <dialog> rather than a hand-rolled overlay, so the Escape key, focus
 * trapping and the inert backdrop all come from the browser rather than from
 * code that has to be kept correct. Zoom is stepped rather than continuous:
 * these are cover images, so fit, double and quadruple answer the question,
 * and a slider would be a fiddlier control for no more information. Above fit,
 * the frame scrolls, which is how you pan.
 */
export function CoverThumb({ id, fileName }: { id: string; fileName: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState<number>(1);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const src = `/api/covers/${id}`;

  // showModal cannot be set declaratively, so the element is driven from state
  // rather than the other way round. Closing is mirrored back because the
  // browser can close a dialog without going through this component: Escape,
  // and the backdrop click below.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setZoom(1);
          setOpen(true);
        }}
        title={`${fileName} (click to view full size)`}
        aria-label={`View ${fileName} full size`}
        className="block rounded ring-1 ring-border transition hover:ring-2 hover:ring-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={`Cover image ${fileName}`}
          className="h-14 w-10 rounded object-cover"
          loading="lazy"
        />
      </button>

      <dialog
        ref={ref}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          // The dialog element fills the viewport, so a click landing on the
          // element itself rather than on its content is a backdrop click.
          if (e.target === ref.current) setOpen(false);
        }}
        // m-auto is not decoration. A modal <dialog> is centred by the user
        // agent's own `margin: auto`, and Tailwind's preflight resets margin to
        // 0 on every element, so without this the dialog opens pinned to the
        // top left corner of the viewport.
        className="m-auto max-h-[92vh] max-w-[92vw] rounded-xl border border-border bg-card p-0 text-foreground backdrop:bg-black/55"
      >
        {/*
          Rendered only while open, and this is not a micro-optimisation. A
          closed <dialog> is still in the document, and a browser fetches an
          <img> inside one exactly as it would anywhere else. With the contents
          always mounted, opening the pool screen requested every cover TWICE,
          the thumbnail and the full-size copy behind a dialog nobody had
          opened: measured at 12 requests for 6 images, so 60 for a pool of 30.
        */}
        {open && (
        <>
        <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-2.5">
          <div className="min-w-0">
            <p className="truncate font-medium">{fileName}</p>
            <p className="text-xs text-muted-foreground">
              {dims ? `${dims.w} by ${dims.h} pixels` : "Loading…"}
              {zoom > 1 && ` · shown at ${zoom}x, scroll to pan`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {ZOOMS.map((z) => (
              <button
                key={z}
                type="button"
                onClick={() => setZoom(z)}
                aria-pressed={zoom === z}
                className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${
                  zoom === z
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card hover:bg-muted"
                }`}
              >
                {z === 1 ? "Fit" : `${z}x`}
              </button>
            ))}
            <a
              href={src}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted"
            >
              Open file
            </a>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted"
            >
              Close
            </button>
          </div>
        </div>

        <div className="max-h-[76vh] overflow-auto bg-muted/40 p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={`Cover image ${fileName}, full size`}
            onLoad={(e) =>
              setDims({
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              })
            }
            onClick={() => setZoom((z) => ZOOMS[(ZOOMS.indexOf(z as 1 | 2 | 4) + 1) % ZOOMS.length])}
            style={
              zoom === 1
                ? { maxHeight: "68vh", width: "auto" }
                : { height: `${68 * zoom}vh`, maxWidth: "none", width: "auto" }
            }
            className="mx-auto block cursor-zoom-in rounded shadow-sm"
          />
        </div>
        </>
        )}
      </dialog>
    </>
  );
}

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
  publishersTruncated,
}: {
  collections: string[];
  publishers: string[];
  /**
   * True when the publisher list is a page of the set rather than all of it.
   *
   * It has to be passed through, because "matches nothing, so it would never be
   * assigned" is a strong claim that is only sound over a COMPLETE list. The
   * page itself is careful about this; the preview was not, so on a catalogue
   * with more publishers than this screen loads it could tell staff to rename a
   * perfectly good publisher cover to "general", turning a correctly targeted
   * cover into a whole-pool fallback: exactly the mismatched-cover outcome the
   * matching rule exists to prevent.
   */
  publishersTruncated: boolean;
}) {
  const [state, action] = useActionState(uploadCoverImages, idleState);
  const [chosen, setChosen] = useState<string[]>([]);

  const previews = chosen.map((name) => {
    const token = tokenFromFileName(name);
    const { scope, matches } = describeToken(token, { collections, publishers, publishersTruncated });
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
          PNG, JPEG, WebP or GIF. Up to 12 files per upload, 1.2MB each and 3.2MB in total. Name each file after the
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
                {p.scope === "unknown" && (
                  <span className="text-amber-700">
                    cannot be checked here: too many publishers to list
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
