"use client";

import { useActionState, useRef } from "react";
import { StatefulForm, SubmitButton, ActionButton } from "@/components/forms";
import { createStocktake, recordScan, closeStocktake, deleteStocktake, undoScan } from "@/app/actions/stocktake";

const fieldCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelCls = "mb-1 block text-xs font-medium text-muted-foreground";

type Opt = { id: string; code: string; name: string };

export function NewStocktakeForm({ collections, locations }: { collections: Opt[]; locations: Opt[] }) {
  return (
    <StatefulForm action={createStocktake}>
      {(state) => (
        <div className="grid gap-3">
          <div>
            <label htmlFor="st-name" className={labelCls}>Name</label>
            <input id="st-name" name="name" placeholder="FY2026 Reference Room count" className={fieldCls} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="st-coll" className={labelCls}>Collection scope</label>
              <select id="st-coll" name="collectionId" defaultValue="" className={fieldCls}>
                <option value="">All collections</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="st-loc" className={labelCls}>Location scope</label>
              <select id="st-loc" name="locationId" defaultValue="" className={fieldCls}>
                <option value="">All locations</option>
                {locations.map((c) => (
                  <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="st-note" className={labelCls}>Note (optional)</label>
            <input id="st-note" name="note" placeholder="Who's counting, which bays…" className={fieldCls} />
          </div>
          {state.ok === false && state.message && <p className="text-sm text-red-700">{state.message}</p>}
          <div><SubmitButton pendingLabel="Opening…">Open stocktake</SubmitButton></div>
        </div>
      )}
    </StatefulForm>
  );
}

/**
 * The counting input. Submits on Enter (scanners send Enter after the code).
 * The box clears at submit time, not on response, and the submit button never
 * disables — a scanner beeping the next item while the previous round-trip is
 * in flight must not have its Enter swallowed by a disabled default button
 * (React queues the actions in order).
 */
export function ScanForm({ stocktakeId }: { stocktakeId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, formAction] = useActionState(recordScan, {} as Parameters<typeof recordScan>[0]);

  return (
    <form
      action={formAction}
      onSubmit={() => {
        // FormData is captured during submit dispatch; clear just after so the
        // next scan lands in an empty box even while this one is in flight.
        setTimeout(() => {
          if (inputRef.current) {
            inputRef.current.value = "";
            inputRef.current.focus();
          }
        }, 0);
      }}
    >
      <input type="hidden" name="stocktakeId" value={stocktakeId} />
      <div className="flex gap-2">
        <input
          ref={inputRef}
          name="barcode"
          autoFocus
          autoComplete="off"
          placeholder="Scan or type a barcode, then Enter"
          className={`${fieldCls} font-mono`}
        />
        <button
          type="submit"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
        >
          Record
        </button>
      </div>
      {state.message && (
        <p
          className={`mt-2 text-sm ${
            state.ok
              ? "text-green-700"
              : state.message.startsWith("MISPLACED") || state.message.startsWith("UNEXPECTED")
                ? "text-amber-700"
                : "text-red-700"
          }`}
        >
          {state.message}
        </p>
      )}
    </form>
  );
}

export function CloseStocktakeForm({
  stocktakeId,
  missing,
  missingAvailable,
}: {
  stocktakeId: string;
  missing: number;
  missingAvailable: number;
}) {
  return (
    <StatefulForm action={closeStocktake}>
      {(state) => (
        <div className="grid gap-2">
          <input type="hidden" name="stocktakeId" value={stocktakeId} />
          {missing > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="markLost" className="h-4 w-4 rounded border-border" />
              <span>
                Mark the {missingAvailable} missing available item{missingAvailable === 1 ? "" : "s"} as Lost
                {missing > missingAvailable &&
                  ` (${missing - missingAvailable} more ${missing - missingAvailable === 1 ? "is" : "are"} missing but in a repair or lost state already, and will keep that status)`}
              </span>
            </label>
          )}
          {state.ok === false && state.message && <p className="text-sm text-red-700">{state.message}</p>}
          <div
            onClickCapture={(e) => {
              // Confirm before the submit reaches the form.
              const t = e.target as HTMLElement;
              if (t.closest("button") && !window.confirm("Close this stocktake? Scanning will be frozen."))
                e.preventDefault();
            }}
          >
            <SubmitButton pendingLabel="Closing…">Close stocktake</SubmitButton>
          </div>
        </div>
      )}
    </StatefulForm>
  );
}

export function DeleteStocktakeButton({ stocktakeId }: { stocktakeId: string }) {
  return (
    <ActionButton
      action={deleteStocktake}
      fields={{ stocktakeId }}
      confirm="Discard this stocktake and all its scans? This cannot be undone."
      className="text-sm text-red-700 hover:underline"
    >
      Discard stocktake
    </ActionButton>
  );
}

export function UndoScanButton({ scanId }: { scanId: string }) {
  return (
    <ActionButton
      action={undoScan}
      fields={{ scanId }}
      className="text-xs text-muted-foreground hover:text-foreground hover:underline"
    >
      undo
    </ActionButton>
  );
}
