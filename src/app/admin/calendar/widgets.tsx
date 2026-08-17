"use client";

import { StatefulForm, SubmitButton } from "@/components/forms";
import { setClosedWeekdays, addClosure } from "@/app/actions/calendar";
import { WEEKDAY_NAMES } from "@/lib/calendar-core";

const fieldCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelCls = "mb-1 block text-xs font-medium text-muted-foreground";

export function WeeklyClosureForm({ closedWeekdays }: { closedWeekdays: number[] }) {
  return (
    <StatefulForm action={setClosedWeekdays}>
      {(state) => (
        <div className="grid gap-3">
          <fieldset>
            <legend className={labelCls}>Closed every…</legend>
            <div className="flex flex-wrap gap-3">
              {WEEKDAY_NAMES.map((name, i) => (
                <label key={name} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    name="weekday"
                    value={i}
                    defaultChecked={closedWeekdays.includes(i)}
                    className="h-4 w-4 rounded border-border accent-primary"
                  />
                  {name.slice(0, 3)}
                </label>
              ))}
            </div>
          </fieldset>
          {state.ok === false && state.message && (
            <p className="text-sm text-red-700">{state.message}</p>
          )}
          <div>
            <SubmitButton pendingLabel="Saving…" variant="outline">Save weekly pattern</SubmitButton>
          </div>
        </div>
      )}
    </StatefulForm>
  );
}

export function ClosureForm() {
  return (
    <StatefulForm action={addClosure}>
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
          <div>
            <label htmlFor="cl-date" className={labelCls}>Date *</label>
            <input id="cl-date" name="date" type="date" required className={fieldCls} />
          </div>
          <div>
            <label htmlFor="cl-name" className={labelCls}>Reason *</label>
            <input id="cl-name" name="name" required maxLength={120}
              placeholder="e.g. Chinese New Year, Stocktake" className={fieldCls} />
          </div>
          <div>
            <SubmitButton pendingLabel="Adding…">＋ Mark closed</SubmitButton>
          </div>
          {state.ok === false && state.message && (
            <p className="text-sm text-red-700 sm:col-span-3">{state.message}</p>
          )}
        </div>
      )}
    </StatefulForm>
  );
}
