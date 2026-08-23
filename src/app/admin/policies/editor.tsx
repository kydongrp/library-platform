"use client";

import { StatefulForm, SubmitButton } from "@/components/forms";
import { updatePolicy } from "@/app/actions/admin-settings";
import { MEMBER_TYPE_LABELS } from "@/lib/constants";

type Policy = {
  memberType: string;
  itemTypeId?: string | null;
  itemType?: { code: string; name: string } | null;
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

export function PolicyEditor({
  policy,
  readOnly,
}: {
  policy: Policy;
  readOnly: boolean;
}) {
  const label =
    policy.memberType === "DEFAULT"
      ? "Default (fallback)"
      : MEMBER_TYPE_LABELS[policy.memberType] ?? policy.memberType;

  return (
    <StatefulForm action={updatePolicy}>
      <input type="hidden" name="memberType" value={policy.memberType} />
      <input type="hidden" name="itemTypeId" value={policy.itemTypeId ?? ""} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold">
          {label}
          {policy.itemType ? (
            <span className="ml-2 rounded-full bg-teal-50 px-2.5 py-0.5 align-middle text-xs font-medium text-teal-800 ring-1 ring-inset ring-teal-200">
              {policy.itemType.code} · {policy.itemType.name}
            </span>
          ) : (
            <span className="ml-2 text-sm font-normal text-muted-foreground">· any item type</span>
          )}
        </h2>
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

/**
 * Adds a member-type × item-type override row. It saves through the same
 * action, so a new row starts from the submitted values.
 */
export function AddOverrideForm({
  itemTypes,
  memberTypes,
}: {
  itemTypes: { id: string; code: string; name: string }[];
  memberTypes: string[];
}) {
  const cls =
    "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
  const lbl = "mb-1 block text-xs font-medium text-muted-foreground";

  if (itemTypes.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Define item types under <a href="/admin/items" className="text-primary hover:underline">Items</a> to
        set rules per format (e.g. a shorter loan for audio-visual).
      </p>
    );

  return (
    <StatefulForm action={updatePolicy}>
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_6rem_6rem_6rem_auto] sm:items-end">
          <div>
            <label className={lbl}>Member type</label>
            <select name="memberType" required defaultValue="" className={cls}>
              <option value="" disabled>Choose…</option>
              {memberTypes.map((m) => (
                <option key={m} value={m}>{MEMBER_TYPE_LABELS[m] ?? m}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={lbl}>Item type</label>
            <select name="itemTypeId" required defaultValue="" className={cls}>
              <option value="" disabled>Choose…</option>
              {itemTypes.map((t) => (
                <option key={t.id} value={t.id}>{t.code} · {t.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={lbl}>Loan days</label>
            <input name="loanDays" type="number" min="0" max="365" defaultValue={7} className={cls} />
          </div>
          <div>
            <label className={lbl}>Max loans</label>
            <input name="maxLoans" type="number" min="0" max="365" defaultValue={5} className={cls} />
          </div>
          <div>
            <label className={lbl}>Fine /day (S$)</label>
            <input name="fineCentsPerDay" inputMode="decimal" defaultValue="0.00" className={cls} />
          </div>
          <SubmitButton pendingLabel="Adding…">＋ Add rule</SubmitButton>
          {state.ok === false && state.message && (
            <p className="text-sm text-red-700 sm:col-span-6">{state.message}</p>
          )}
        </div>
      )}
    </StatefulForm>
  );
}
