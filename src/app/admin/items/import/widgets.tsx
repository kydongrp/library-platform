"use client";

import { StatefulForm, SubmitButton } from "@/components/forms";
import { importItems } from "@/app/actions/items";

const fieldCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelCls = "mb-1 block text-xs font-medium text-muted-foreground";

export function ImportItemsForm() {
  return (
    <StatefulForm action={importItems}>
      {(state) => (
        <div className="grid gap-3">
          <div>
            <label htmlFor="ii-file" className={labelCls}>XML, CSV or JSON file</label>
            <input
              id="ii-file"
              name="file"
              type="file"
              accept=".xml,.csv,.json,.txt"
              className={`${fieldCls} file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1 file:text-xs file:font-medium file:text-primary`}
            />
          </div>
          <div>
            <label htmlFor="ii-paste" className={labelCls}>…or paste rows</label>
            <textarea
              id="ii-paste"
              name="pasted"
              rows={4}
              placeholder={
                "barcode,isbn,collection,location,itemtype,status\nLIB-000123,978-0-13-468599-1,GEN,MAIN,BOOK,AVAILABLE"
              }
              className={`${fieldCls} font-mono text-xs`}
            />
          </div>
          {state.ok === false && state.message && <p className="text-sm text-red-700">{state.message}</p>}
          {state.ok === true && state.message && <p className="text-sm text-green-700">{state.message}</p>}
          <div><SubmitButton pendingLabel="Importing…">⇪ Import items</SubmitButton></div>
        </div>
      )}
    </StatefulForm>
  );
}
