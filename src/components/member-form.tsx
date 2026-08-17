"use client";

import { useState } from "react";
import { StatefulForm, SubmitButton } from "@/components/forms";
import { MEMBER_TYPES, MEMBER_TYPE_LABELS, MEMBER_LANGUAGES } from "@/lib/constants";
import type { ActionState } from "@/lib/types";

type Defaults = {
  id?: string;
  name?: string;
  email?: string;
  memberType?: string;
  status?: string;
  phone?: string;
  language?: string;
  location?: string;
  department?: string;
  maxLoans?: number;
};

export type StatusOption = { name: string; canBorrow: boolean; isDefault: boolean };

const labelCls = "block text-sm font-medium text-foreground mb-1.5";
const inputCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

export function MemberForm({
  action,
  statuses,
  defaults = {},
  submitLabel = "Save",
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  statuses: StatusOption[];
  defaults?: Defaults;
  submitLabel?: string;
}) {
  const [memberType, setMemberType] = useState(defaults.memberType ?? "STUDENT");
  const defaultStatus =
    defaults.status ?? statuses.find((s) => s.isDefault)?.name ?? statuses[0]?.name ?? "Active";

  return (
    <StatefulForm action={action} className="max-w-2xl space-y-4">
      {(state) => (
        <>
          {defaults.id && <input type="hidden" name="id" value={defaults.id} />}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="name">Full name *</label>
              <input id="name" name="name" required defaultValue={defaults.name ?? ""} className={inputCls} />
            </div>
            <div>
              <label className={labelCls} htmlFor="email">Email *</label>
              <input id="email" name="email" type="email" required defaultValue={defaults.email ?? ""} className={inputCls} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="phone">Phone</label>
              <input id="phone" name="phone" defaultValue={defaults.phone ?? ""}
                placeholder="+65 9123 4567" className={inputCls} />
            </div>
            <div>
              <label className={labelCls} htmlFor="language">Preferred language</label>
              <select id="language" name="language" defaultValue={defaults.language ?? "English"} className={inputCls}>
                {MEMBER_LANGUAGES.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="location">Location (campus / site)</label>
              <input id="location" name="location" defaultValue={defaults.location ?? ""}
                placeholder="e.g. Depot Road Campus" className={inputCls} />
            </div>
            <div>
              <label className={labelCls} htmlFor="department">Department</label>
              <input id="department" name="department" defaultValue={defaults.department ?? ""}
                placeholder="e.g. Engineering Faculty" className={inputCls} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className={labelCls} htmlFor="memberType">Member type</label>
              <select id="memberType" name="memberType" value={memberType}
                onChange={(e) => setMemberType(e.target.value)} className={inputCls}>
                {MEMBER_TYPES.map((t) => (
                  <option key={t} value={t}>{MEMBER_TYPE_LABELS[t]}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                Loan period set by Loan Policies for this member type
              </p>
            </div>
            <div>
              <label className={labelCls} htmlFor="status">Status</label>
              <select id="status" name="status" defaultValue={defaultStatus} className={inputCls}>
                {statuses.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}{s.canBorrow ? "" : " (no borrowing)"}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="maxLoans">Max concurrent loans</label>
              <input id="maxLoans" name="maxLoans" type="number" min="1" max="50"
                defaultValue={defaults.maxLoans ?? ""} placeholder="Type default"
                className={inputCls} />
            </div>
          </div>

          {state.ok === false && state.message && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{state.message}</p>
          )}

          <div className="pt-1">
            <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
          </div>
        </>
      )}
    </StatefulForm>
  );
}
