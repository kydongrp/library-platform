"use client";

import { StatefulForm, SubmitButton } from "@/components/forms";
import { registerSerial, updateSerial } from "@/app/actions/serials";
import { FREQUENCIES, FREQUENCY_LABELS, type Frequency } from "@/lib/serials-shared";

const fieldCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelCls = "mb-1 block text-xs font-medium text-muted-foreground";

export type SerialOption = { id: string; title: string };

export function RegisterSerialForm({ options }: { options: SerialOption[] }) {
  return (
    <StatefulForm action={registerSerial}>
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="rs-resource" className={labelCls}>Journal / magazine title *</label>
            <select id="rs-resource" name="resourceId" required className={fieldCls} defaultValue="">
              <option value="" disabled>Choose a catalogue title…</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>{o.title}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="rs-frequency" className={labelCls}>Frequency *</label>
              <select id="rs-frequency" name="frequency" required defaultValue="MONTHLY" className={fieldCls}>
                {FREQUENCIES.map((fq) => (
                  <option key={fq} value={fq}>{FREQUENCY_LABELS[fq]}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="rs-first" className={labelCls}>First expected *</label>
              <input id="rs-first" name="firstExpected" type="date" required className={fieldCls} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="rs-issn" className={labelCls}>ISSN</label>
              <input id="rs-issn" name="issn" placeholder="1234-5678" className={fieldCls} />
            </div>
            <div>
              <label htmlFor="rs-claim" className={labelCls}>Vendor claim email</label>
              <input id="rs-claim" name="claimEmail" type="email"
                placeholder="serials@vendor.com" className={fieldCls} />
            </div>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="rs-notes" className={labelCls}>Notes</label>
            <input id="rs-notes" name="notes" maxLength={1000}
              placeholder="Account ref, format, routing…" className={fieldCls} />
          </div>
          {state.ok === false && state.message && (
            <p className="text-sm text-red-700 sm:col-span-2">{state.message}</p>
          )}
          <div className="sm:col-span-2">
            <SubmitButton pendingLabel="Registering…">＋ Register serial</SubmitButton>
          </div>
        </div>
      )}
    </StatefulForm>
  );
}

export type SerialEditValues = {
  id: string;
  issn: string;
  frequency: Frequency;
  status: string;
  claimEmail: string;
  notes: string;
};

export function EditSerialForm({ serial }: { serial: SerialEditValues }) {
  return (
    <StatefulForm action={updateSerial} key={serial.id}>
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-4">
          <input type="hidden" name="id" value={serial.id} />
          <div>
            <label className={labelCls}>Frequency</label>
            <select name="frequency" defaultValue={serial.frequency} className={fieldCls}>
              {FREQUENCIES.map((fq) => (
                <option key={fq} value={fq}>{FREQUENCY_LABELS[fq]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Status</label>
            <select name="status" defaultValue={serial.status} className={fieldCls}>
              <option value="ACTIVE">Active</option>
              <option value="PAUSED">Paused</option>
              <option value="CLOSED">Closed</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>ISSN</label>
            <input name="issn" defaultValue={serial.issn} className={fieldCls} />
          </div>
          <div>
            <label className={labelCls}>Vendor claim email</label>
            <input name="claimEmail" type="email" defaultValue={serial.claimEmail} className={fieldCls} />
          </div>
          <div className="sm:col-span-3">
            <label className={labelCls}>Notes</label>
            <input name="notes" defaultValue={serial.notes} maxLength={1000} className={fieldCls} />
          </div>
          {state.ok === false && state.message && (
            <p className="text-sm text-red-700 sm:col-span-4">{state.message}</p>
          )}
          <div className="flex items-end">
            <SubmitButton pendingLabel="Saving…" variant="outline">Save</SubmitButton>
          </div>
        </div>
      )}
    </StatefulForm>
  );
}
