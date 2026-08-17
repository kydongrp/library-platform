"use client";

import { StatefulForm, SubmitButton } from "@/components/forms";
import { createMemberStatus, importMembers } from "@/app/actions/members";

const fieldCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelCls = "mb-1 block text-xs font-medium text-muted-foreground";

export function StatusForm() {
  return (
    <StatefulForm action={createMemberStatus}>
      {(state) => (
        <div className="grid gap-3">
          <div className="grid grid-cols-[1fr_auto_auto] items-end gap-3">
            <div>
              <label htmlFor="ms-name" className={labelCls}>New status name</label>
              <input id="ms-name" name="name" required maxLength={40}
                placeholder="e.g. Alumni, Graduated, On exchange" className={fieldCls} />
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" name="canBorrow" defaultChecked
                className="h-4 w-4 rounded border-border accent-primary" />
              Can borrow
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" name="isDefault"
                className="h-4 w-4 rounded border-border accent-primary" />
              Default
            </label>
          </div>
          {state.ok === false && state.message && (
            <p className="text-sm text-red-700">{state.message}</p>
          )}
          <div><SubmitButton pendingLabel="Adding…" variant="outline">＋ Add status</SubmitButton></div>
        </div>
      )}
    </StatefulForm>
  );
}

export function ImportMembersForm() {
  return (
    <StatefulForm action={importMembers}>
      {(state) => (
        <div className="grid gap-3">
          <div>
            <label htmlFor="mi-file" className={labelCls}>CSV file</label>
            <input id="mi-file" name="file" type="file" accept=".csv,.txt"
              className={`${fieldCls} file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1 file:text-xs file:font-medium file:text-primary`} />
          </div>
          <div>
            <label htmlFor="mi-paste" className={labelCls}>…or paste rows</label>
            <textarea id="mi-paste" name="pasted" rows={3}
              placeholder={"name,email,type,status,phone,language,location,department\nAisha Rahman,aisha@example.edu,STUDENT,Active,+65 9000 0001,Malay,Depot Road Campus,Business School"}
              className={`${fieldCls} font-mono text-xs`} />
          </div>
          {state.ok === false && state.message && (
            <p className="text-sm text-red-700">{state.message}</p>
          )}
          {state.ok === true && state.message && (
            <p className="text-sm text-green-700">{state.message}</p>
          )}
          <div><SubmitButton pendingLabel="Importing…">⇪ Import members</SubmitButton></div>
        </div>
      )}
    </StatefulForm>
  );
}
