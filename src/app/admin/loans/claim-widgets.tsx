"use client";

import { StatefulForm, SubmitButton, ActionButton } from "@/components/forms";
import { claimReturned, withdrawClaim, writeOffClaim } from "@/app/actions/claims";

const fieldCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

/**
 * Raising a claim takes a note ("says returned to the drop box on Tuesday"),
 * so it is a small form rather than a one-click action. The note is what
 * makes the claim answerable later.
 *
 * The disclosure is a native <details> rather than React state on purpose:
 * the desk has to be able to record a claim even if the page has not
 * hydrated, and a plain form POST is the one thing that always works.
 */
export function ClaimReturnButton({ loanId }: { loanId: string }) {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted">
        Claims returned
      </summary>
      <StatefulForm action={claimReturned} className="mt-2 flex flex-wrap items-center gap-2">
        <input type="hidden" name="loanId" value={loanId} />
        <input
          name="note"
          placeholder="Where and when they say it went back"
          className={`${fieldCls} !w-64 !py-1.5 text-xs`}
        />
        <SubmitButton pendingLabel="…" variant="outline" className="!px-3 !py-1.5 text-xs">
          Record claim
        </SubmitButton>
      </StatefulForm>
    </details>
  );
}

export function WithdrawClaimButton({ loanId }: { loanId: string }) {
  return (
    <ActionButton
      action={withdrawClaim}
      fields={{ loanId }}
      variant="outline"
      className="!px-3 !py-1.5 text-xs"
      pendingLabel="…"
      confirm="Withdraw the claim? The loan goes back to normal and fines resume from its due date."
    >
      Withdraw claim
    </ActionButton>
  );
}

export function WriteOffClaimButton({ loanId, title }: { loanId: string; title: string }) {
  return (
    <ActionButton
      action={writeOffClaim}
      fields={{ loanId }}
      variant="outline"
      className="!px-3 !py-1.5 text-xs text-red-700"
      pendingLabel="…"
      confirm={`Write off "${title}" as lost? The loan closes, the copy is marked Lost, and any fine already accrued stands.`}
    >
      Write off as lost
    </ActionButton>
  );
}
