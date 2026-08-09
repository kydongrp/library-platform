"use client";

import { StatefulForm, SubmitButton, ActionButton } from "@/components/forms";
import { submitRequest, cancelRequest } from "@/app/actions/requests";

const inputCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

export function RequestForm() {
  return (
    <StatefulForm action={submitRequest} className="space-y-4">
      {(state) => (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium" htmlFor="req-title">Title *</label>
              <input id="req-title" name="title" required className={inputCls}
                placeholder="e.g. Refactoring, 2nd Edition" />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium" htmlFor="req-author">Author</label>
              <input id="req-author" name="author" className={inputCls} placeholder="e.g. Martin Fowler" />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium" htmlFor="req-details">
              Details <span className="font-normal text-muted-foreground">(edition, link, why it&apos;s useful…)</span>
            </label>
            <textarea id="req-details" name="details" rows={3} className={inputCls} />
          </div>
          {state.ok === false && state.message && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{state.message}</p>
          )}
          <SubmitButton pendingLabel="Submitting…">Submit request</SubmitButton>
        </>
      )}
    </StatefulForm>
  );
}

export function WithdrawButton({ requestId }: { requestId: string }) {
  return (
    <ActionButton
      action={cancelRequest}
      fields={{ requestId }}
      variant="outline"
      className="!px-3 !py-1.5 text-xs"
      confirm="Withdraw this request?"
      pendingLabel="…"
    >
      Withdraw
    </ActionButton>
  );
}
