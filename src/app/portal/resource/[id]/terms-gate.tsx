"use client";

import { StatefulForm, SubmitButton } from "@/components/forms";
import { Card } from "@/components/ui";
import { acceptTerms } from "@/app/actions/requests";

/**
 * One-time terms & conditions acceptance gate shown before a member's first
 * access to digital resources (contract FR 8.1).
 */
export function TermsGate({ provider }: { provider?: string | null }) {
  return (
    <Card className="max-w-xl p-5">
      <h3 className="font-display text-lg font-semibold">Digital resource terms of use</h3>
      <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-foreground/80">
        <li>Access is for your personal learning and research only.</li>
        <li>
          Content{provider ? ` from ${provider}` : ""} remains the provider&apos;s copyright —
          no bulk downloading, redistribution, or sharing of access.
        </li>
        <li>Your usage may be logged for licence compliance and analytics.</li>
      </ul>
      <StatefulForm action={acceptTerms} className="mt-4">
        <SubmitButton pendingLabel="Saving…">I accept — continue to digital resources</SubmitButton>
      </StatefulForm>
      <p className="mt-2 text-xs text-muted-foreground">
        You only need to accept once. Applies to all digital and external resources.
      </p>
    </Card>
  );
}
