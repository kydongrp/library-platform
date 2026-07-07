"use client";

import { useState } from "react";
import { StatefulForm, SubmitButton } from "@/components/forms";
import { MEMBER_TYPES, MEMBER_TYPE_LABELS, LOAN_PERIOD_DAYS } from "@/lib/constants";
import type { ActionState } from "@/lib/types";

type Defaults = {
  id?: string;
  name?: string;
  email?: string;
  memberType?: string;
  status?: string;
  maxLoans?: number;
};

const labelCls = "block text-sm font-medium text-foreground mb-1.5";
const inputCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

export function MemberForm({
  action,
  defaults = {},
  submitLabel = "Save",
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  defaults?: Defaults;
  submitLabel?: string;
}) {
  const [memberType, setMemberType] = useState(defaults.memberType ?? "STUDENT");

  return (
    <StatefulForm action={action} className="max-w-lg space-y-4">
      {(state) => (
        <>
          {defaults.id && <input type="hidden" name="id" value={defaults.id} />}

          <div>
            <label className={labelCls} htmlFor="name">Full name *</label>
            <input id="name" name="name" required defaultValue={defaults.name ?? ""} className={inputCls} />
          </div>

          <div>
            <label className={labelCls} htmlFor="email">Email *</label>
            <input id="email" name="email" type="email" required defaultValue={defaults.email ?? ""} className={inputCls} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="memberType">Member type</label>
              <select id="memberType" name="memberType" value={memberType}
                onChange={(e) => setMemberType(e.target.value)} className={inputCls}>
                {MEMBER_TYPES.map((t) => (
                  <option key={t} value={t}>{MEMBER_TYPE_LABELS[t]}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                Loan period: {LOAN_PERIOD_DAYS[memberType]} days
              </p>
            </div>
            <div>
              <label className={labelCls} htmlFor="status">Status</label>
              <select id="status" name="status" defaultValue={defaults.status ?? "ACTIVE"} className={inputCls}>
                <option value="ACTIVE">Active</option>
                <option value="SUSPENDED">Suspended</option>
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls} htmlFor="maxLoans">Max concurrent loans</label>
            <input id="maxLoans" name="maxLoans" type="number" min="1" max="50"
              defaultValue={defaults.maxLoans ?? ""} placeholder="Default for member type"
              className={inputCls} />
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
