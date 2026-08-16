"use client";

import Link from "next/link";
import { StatefulForm, SubmitButton } from "@/components/forms";
import {
  saveSubscription,
  ingestCounterUsage,
  addUsageMonth,
} from "@/app/actions/eresources";

const fieldCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelCls = "mb-1 block text-xs font-medium text-muted-foreground";

/** Serialisable snapshot of a subscription for prefilling the edit form. */
export type SubFormValues = {
  id: string;
  provider: string;
  renewalDate: string; // YYYY-MM-DD
  startDate: string; // YYYY-MM-DD or ""
  autoRenews: boolean;
  annualCost: string; // "12400.00" or ""
  currency: string;
  seats: string;
  notes: string;
};

// All three forms share the page-level <datalist id="provider-options">
// rendered once by the server page.
export function SubscriptionForm({ editing }: { editing: SubFormValues | null }) {
  return (
    <StatefulForm action={saveSubscription} key={editing?.id ?? "new"}>
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          {editing && <input type="hidden" name="id" value={editing.id} />}
          <div>
            <label htmlFor="sub-provider" className={labelCls}>Provider *</label>
            <input
              id="sub-provider"
              name="provider"
              required
              list="provider-options"
              defaultValue={editing?.provider ?? ""}
              placeholder="e.g. IEEE Xplore"
              className={fieldCls}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="sub-renewal" className={labelCls}>Renewal date *</label>
              <input id="sub-renewal" name="renewalDate" type="date" required
                defaultValue={editing?.renewalDate ?? ""} className={fieldCls} />
            </div>
            <div>
              <label htmlFor="sub-start" className={labelCls}>Start date</label>
              <input id="sub-start" name="startDate" type="date"
                defaultValue={editing?.startDate ?? ""} className={fieldCls} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label htmlFor="sub-cost" className={labelCls}>Annual cost</label>
              <input id="sub-cost" name="annualCost" inputMode="decimal"
                placeholder="12400.00" defaultValue={editing?.annualCost ?? ""} className={fieldCls} />
            </div>
            <div>
              <label htmlFor="sub-currency" className={labelCls}>Currency</label>
              <input id="sub-currency" name="currency" maxLength={3}
                defaultValue={editing?.currency ?? "SGD"} className={`${fieldCls} uppercase`} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="sub-seats" className={labelCls}>Concurrent seats</label>
              <input id="sub-seats" name="seats" type="number" min={0}
                placeholder="unlimited" defaultValue={editing?.seats ?? ""} className={fieldCls} />
            </div>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="autoRenews" defaultChecked={editing?.autoRenews ?? false}
                  className="h-4 w-4 rounded border-border accent-primary" />
                Auto-renews
              </label>
            </div>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="sub-notes" className={labelCls}>
              Licence terms / notes (cancellation window, account ref, contact)
            </label>
            <textarea id="sub-notes" name="notes" rows={2} maxLength={2000}
              defaultValue={editing?.notes ?? ""} className={fieldCls} />
          </div>
          {state.ok === false && state.message && (
            <p className="text-sm text-red-700 sm:col-span-2">{state.message}</p>
          )}
          <div className="flex items-center gap-3 sm:col-span-2">
            <SubmitButton pendingLabel="Saving…">
              {editing ? "Save changes" : "＋ Register subscription"}
            </SubmitButton>
            {editing && (
              <Link href="/admin/eresources" className="text-sm text-muted-foreground hover:underline">
                Cancel edit
              </Link>
            )}
          </div>
        </div>
      )}
    </StatefulForm>
  );
}

export function UsageUploadForm() {
  return (
    <StatefulForm action={ingestCounterUsage}>
      {(state) => (
        <div className="grid gap-3">
          <div>
            <label htmlFor="cu-provider" className={labelCls}>Provider *</label>
            <input id="cu-provider" name="provider" required list="provider-options"
              placeholder="Which platform is this report from?" className={fieldCls} />
          </div>
          <div>
            <label htmlFor="cu-file" className={labelCls}>COUNTER report file (CSV / TSV)</label>
            <input id="cu-file" name="file" type="file" accept=".csv,.tsv,.txt"
              className={`${fieldCls} file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1 file:text-xs file:font-medium file:text-primary`} />
          </div>
          <div>
            <label htmlFor="cu-paste" className={labelCls}>…or paste the report contents</label>
            <textarea id="cu-paste" name="pasted" rows={3}
              placeholder={"Title,Publisher,…,Metric_Type,Reporting_Period_Total,Jan-2026,Feb-2026,…"}
              className={`${fieldCls} font-mono text-xs`} />
          </div>
          {state.ok === false && state.message && (
            <p className="text-sm text-red-700">{state.message}</p>
          )}
          {state.ok === true && state.message && (
            <p className="text-sm text-green-700">{state.message}</p>
          )}
          <div>
            <SubmitButton pendingLabel="Importing…" variant="outline">⇪ Import usage</SubmitButton>
          </div>
        </div>
      )}
    </StatefulForm>
  );
}

export function ManualUsageForm() {
  return (
    <StatefulForm action={addUsageMonth}>
      {(state) => (
        <div className="grid gap-3">
          <div>
            <label htmlFor="mu-provider" className={labelCls}>Provider *</label>
            <input id="mu-provider" name="provider" required list="provider-options"
              className={fieldCls} placeholder="e.g. Janes" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="mu-period" className={labelCls}>Month *</label>
              <input id="mu-period" name="period" type="month" required className={fieldCls} />
            </div>
            <div>
              <label htmlFor="mu-count" className={labelCls}>Item requests *</label>
              <input id="mu-count" name="count" type="number" min={0} required
                placeholder="0" className={fieldCls} />
            </div>
          </div>
          {state.ok === false && state.message && (
            <p className="text-sm text-red-700">{state.message}</p>
          )}
          <div>
            <SubmitButton pendingLabel="Saving…" variant="outline">Record month</SubmitButton>
          </div>
        </div>
      )}
    </StatefulForm>
  );
}
