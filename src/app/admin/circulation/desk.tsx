"use client";

import { StatefulForm, SubmitButton } from "@/components/forms";
import { Card } from "@/components/ui";
import { checkout, checkin } from "@/app/actions/circulation";

type MemberOption = { id: string; name: string; memberType: string };

const inputCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelCls = "block text-sm font-medium mb-1.5";

export function CirculationDesk({ members }: { members: MemberOption[] }) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      {/* Check out */}
      <Card className="p-6">
        <div className="mb-1 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">→</span>
          <h2 className="font-display text-xl font-semibold">Check out</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Loan a copy to a member by scanning its barcode.
        </p>
        <StatefulForm action={checkout} className="space-y-4">
          {(state) => (
            <>
              <div>
                <label className={labelCls} htmlFor="co-member">Member</label>
                <select id="co-member" name="memberId" required defaultValue="" className={inputCls}>
                  <option value="" disabled>Select a member…</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>{m.name} · {m.memberType.toLowerCase()}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls} htmlFor="co-barcode">Copy barcode</label>
                <input id="co-barcode" name="barcode" placeholder="e.g. LIB-001001" autoComplete="off" className={`${inputCls} font-mono`} />
              </div>
              {state.ok === false && state.message && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{state.message}</p>
              )}
              <SubmitButton pendingLabel="Checking out…">Check out</SubmitButton>
            </>
          )}
        </StatefulForm>
      </Card>

      {/* Check in */}
      <Card className="p-6">
        <div className="mb-1 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">←</span>
          <h2 className="font-display text-xl font-semibold">Check in</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Return a copy by scanning its barcode. Any overdue fine is worked out
          against the library calendar, and the next hold is filled automatically.
        </p>
        <StatefulForm action={checkin} className="space-y-4">
          {(state) => (
            <>
              <div>
                <label className={labelCls} htmlFor="ci-barcode">Copy barcode</label>
                <input id="ci-barcode" name="barcode" placeholder="e.g. LIB-001001" autoComplete="off" className={`${inputCls} font-mono`} />
              </div>
              <div>
                <label className={labelCls} htmlFor="ci-condition">Condition on return</label>
                <select id="ci-condition" name="condition" defaultValue="GOOD" className={inputCls}>
                  <option value="GOOD">Good (back on the shelf)</option>
                  <option value="DAMAGED">Damaged (send to maintenance)</option>
                  <option value="LOST">Lost (withdraw the copy)</option>
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Damaged and lost copies leave circulation, so a waiting hold is not filled from them.
                </p>
              </div>
              {state.ok === false && state.message && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{state.message}</p>
              )}
              <SubmitButton variant="accent" pendingLabel="Checking in…">Check in</SubmitButton>
            </>
          )}
        </StatefulForm>
      </Card>
    </div>
  );
}
