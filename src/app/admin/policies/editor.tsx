"use client";

import { StatefulForm, SubmitButton } from "@/components/forms";
import { updatePolicy } from "@/app/actions/admin-settings";
import { MEMBER_TYPE_LABELS } from "@/lib/constants";

type Policy = {
  memberType: string;
  loanDays: number;
  maxLoans: number;
  maxRenewals: number;
  renewalDays: number;
  digitalDays: number;
  holdPickupDays: number;
};

const FIELDS: { name: keyof Policy; label: string; hint: string }[] = [
  { name: "loanDays", label: "Loan period (days)", hint: "Physical checkout length" },
  { name: "maxLoans", label: "Max concurrent loans", hint: "Active loans allowed" },
  { name: "maxRenewals", label: "Max renewals", hint: "Per loan" },
  { name: "renewalDays", label: "Renewal extension (days)", hint: "Added per renewal" },
  { name: "digitalDays", label: "Digital loan (days)", hint: "E-books & audiobooks" },
  { name: "holdPickupDays", label: "Hold pickup window (days)", hint: "Before a ready hold expires" },
];

export function PolicyEditor({ policy, readOnly }: { policy: Policy; readOnly: boolean }) {
  const label =
    policy.memberType === "DEFAULT"
      ? "Default (fallback)"
      : MEMBER_TYPE_LABELS[policy.memberType] ?? policy.memberType;

  return (
    <StatefulForm action={updatePolicy}>
      <input type="hidden" name="memberType" value={policy.memberType} />
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold">{label}</h2>
        {!readOnly && <SubmitButton variant="outline" pendingLabel="Saving…">Save</SubmitButton>}
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {FIELDS.map((f) => (
          <div key={f.name}>
            <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor={`${policy.memberType}-${f.name}`}>
              {f.label}
            </label>
            <input
              id={`${policy.memberType}-${f.name}`}
              name={f.name}
              type="number"
              min="0"
              max="365"
              defaultValue={policy[f.name] as number}
              disabled={readOnly}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:bg-muted disabled:text-muted-foreground"
            />
            <p className="mt-1 text-[11px] leading-tight text-muted-foreground">{f.hint}</p>
          </div>
        ))}
      </div>
    </StatefulForm>
  );
}
