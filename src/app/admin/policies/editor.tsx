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
  fineCentsPerDay: number;
  fineGraceDays: number;
  maxFineCents: number | null;
};

type FieldKind = "days" | "money" | "moneyOrBlank";

const FIELDS: { name: keyof Policy; label: string; hint: string; kind: FieldKind }[] = [
  { name: "loanDays", label: "Loan period (days)", hint: "Physical checkout length", kind: "days" },
  { name: "maxLoans", label: "Max concurrent loans", hint: "Active loans allowed", kind: "days" },
  { name: "maxRenewals", label: "Max renewals", hint: "Per loan", kind: "days" },
  { name: "renewalDays", label: "Renewal extension (days)", hint: "Added per renewal", kind: "days" },
  { name: "digitalDays", label: "Digital loan (days)", hint: "E-books & audiobooks", kind: "days" },
  { name: "holdPickupDays", label: "Hold pickup window (days)", hint: "Before a ready hold expires", kind: "days" },
  { name: "fineCentsPerDay", label: "Fine per day (S$)", hint: "0 = never fined. Charged per open day.", kind: "money" },
  { name: "fineGraceDays", label: "Grace (open days)", hint: "Free days before fines start", kind: "days" },
  { name: "maxFineCents", label: "Maximum fine (S$)", hint: "Blank = no cap", kind: "moneyOrBlank" },
];

/** Money fields are edited in dollars but stored in cents. */
function displayValue(policy: Policy, name: keyof Policy, kind: FieldKind): string {
  const raw = policy[name];
  if (kind === "days") return String(raw ?? 0);
  if (raw == null) return "";
  return ((raw as number) / 100).toFixed(2);
}

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
              type={f.kind === "days" ? "number" : "text"}
              inputMode={f.kind === "days" ? undefined : "decimal"}
              min={f.kind === "days" ? "0" : undefined}
              max={f.kind === "days" ? "365" : undefined}
              placeholder={f.kind === "moneyOrBlank" ? "no cap" : undefined}
              defaultValue={displayValue(policy, f.name, f.kind)}
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
