"use client";

import { StatefulForm, SubmitButton } from "@/components/forms";
import {
  createSupplier,
  createFund,
  createPurchaseOrder,
  recordInvoice,
} from "@/app/actions/acquisitions";

const fieldCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelCls = "mb-1 block text-xs font-medium text-muted-foreground";

export type IdName = { id: string; name: string };

function Err({ state }: { state: { ok?: boolean; message?: string } }) {
  return state.ok === false && state.message ? (
    <p className="text-sm text-red-700">{state.message}</p>
  ) : null;
}

export function SupplierForm() {
  return (
    <StatefulForm action={createSupplier}>
      {(state) => (
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="sp-name" className={labelCls}>Supplier name *</label>
              <input id="sp-name" name="name" required maxLength={120}
                placeholder="e.g. Knovel (Elsevier)" className={fieldCls} />
            </div>
            <div>
              <label htmlFor="sp-email" className={labelCls}>Email</label>
              <input id="sp-email" name="email" type="email"
                placeholder="orders@vendor.com" className={fieldCls} />
            </div>
          </div>
          <div>
            <label htmlFor="sp-contact" className={labelCls}>Contact (person / phone)</label>
            <input id="sp-contact" name="contact" maxLength={200} className={fieldCls} />
          </div>
          <Err state={state} />
          <div><SubmitButton pendingLabel="Adding…" variant="outline">＋ Add supplier</SubmitButton></div>
        </div>
      )}
    </StatefulForm>
  );
}

export function FundForm() {
  return (
    <StatefulForm action={createFund}>
      {(state) => (
        <div className="grid gap-3">
          <div className="grid grid-cols-4 gap-3">
            <div>
              <label htmlFor="fd-fy" className={labelCls}>Fiscal year *</label>
              <input id="fd-fy" name="fiscalYear" required defaultValue="FY2026"
                pattern="FY\d{4}" className={fieldCls} />
            </div>
            <div className="col-span-2">
              <label htmlFor="fd-name" className={labelCls}>Fund name *</label>
              <input id="fd-name" name="name" required maxLength={80}
                placeholder="e.g. Digital subscriptions" className={fieldCls} />
            </div>
            <div>
              <label htmlFor="fd-amount" className={labelCls}>Budget *</label>
              <input id="fd-amount" name="amount" required inputMode="decimal"
                placeholder="50000" className={fieldCls} />
            </div>
          </div>
          <input type="hidden" name="currency" value="SGD" />
          <Err state={state} />
          <div><SubmitButton pendingLabel="Creating…" variant="outline">＋ Create fund</SubmitButton></div>
        </div>
      )}
    </StatefulForm>
  );
}

const LINE_SLOTS = [1, 2, 3, 4, 5];

export function PurchaseOrderForm({ suppliers, funds }: { suppliers: IdName[]; funds: IdName[] }) {
  return (
    <StatefulForm action={createPurchaseOrder}>
      {(state) => (
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="po-supplier" className={labelCls}>Supplier *</label>
              <select id="po-supplier" name="supplierId" required defaultValue="" className={fieldCls}>
                <option value="" disabled>Choose…</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="po-fund" className={labelCls}>Fund *</label>
              <select id="po-fund" name="fundId" required defaultValue="" className={fieldCls}>
                <option value="" disabled>Choose…</option>
                {funds.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <span className={labelCls}>Order lines (title · qty · unit price) — fill what you need</span>
            <div className="grid gap-1.5">
              {LINE_SLOTS.map((i) => (
                <div key={i} className="grid grid-cols-[1fr_4.5rem_6rem] gap-1.5">
                  <input name={`line${i}Title`} placeholder={i === 1 ? "Title *" : `Line ${i} title`}
                    aria-label={`Line ${i} title`} maxLength={300} className={fieldCls} />
                  <input name={`line${i}Qty`} inputMode="numeric" placeholder="1"
                    aria-label={`Line ${i} quantity`} className={fieldCls} />
                  <input name={`line${i}Unit`} inputMode="decimal" placeholder="0.00"
                    aria-label={`Line ${i} unit price`} className={fieldCls} />
                </div>
              ))}
            </div>
          </div>
          <div>
            <label htmlFor="po-notes" className={labelCls}>Notes</label>
            <input id="po-notes" name="notes" maxLength={1000}
              placeholder="Quote ref, delivery instructions…" className={fieldCls} />
          </div>
          <Err state={state} />
          <div><SubmitButton pendingLabel="Raising order…">＋ Raise purchase order</SubmitButton></div>
        </div>
      )}
    </StatefulForm>
  );
}

export function InvoiceForm({
  suppliers,
  funds,
  openOrders,
}: {
  suppliers: IdName[];
  funds: IdName[];
  openOrders: { id: string; label: string }[];
}) {
  return (
    <StatefulForm action={recordInvoice}>
      {(state) => (
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="in-supplier" className={labelCls}>Supplier *</label>
              <select id="in-supplier" name="supplierId" required defaultValue="" className={fieldCls}>
                <option value="" disabled>Choose…</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="in-fund" className={labelCls}>Charge to fund *</label>
              <select id="in-fund" name="fundId" required defaultValue="" className={fieldCls}>
                <option value="" disabled>Choose…</option>
                {funds.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="in-number" className={labelCls}>Invoice no. *</label>
              <input id="in-number" name="invoiceNumber" required maxLength={60}
                placeholder="INV-88123" className={fieldCls} />
            </div>
            <div>
              <label htmlFor="in-amount" className={labelCls}>Amount *</label>
              <input id="in-amount" name="amount" required inputMode="decimal"
                placeholder="1290.00" className={fieldCls} />
            </div>
            <div>
              <label htmlFor="in-date" className={labelCls}>Invoice date *</label>
              <input id="in-date" name="invoiceDate" type="date" required className={fieldCls} />
            </div>
          </div>
          <div>
            <label htmlFor="in-po" className={labelCls}>Against purchase order (optional)</label>
            <select id="in-po" name="poId" defaultValue="" className={fieldCls}>
              <option value="">— none —</option>
              {openOrders.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
          <Err state={state} />
          <div><SubmitButton pendingLabel="Recording…" variant="outline">＋ Record invoice</SubmitButton></div>
        </div>
      )}
    </StatefulForm>
  );
}
