"use client";

import { StatefulForm, SubmitButton, ActionButton } from "@/components/forms";
import {
  createBooking,
  confirmBooking,
  cancelBooking,
  collectBooking,
  markNoShow,
} from "@/app/actions/bookings";

const fieldCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelCls = "mb-1 block text-xs font-medium text-muted-foreground";

/**
 * Staff-side booking form. Uses datetime-local inputs, which post a local
 * wall-clock string — the desk thinks in "Tuesday 2pm", not in UTC.
 */
export function NewBookingForm({ defaultStart }: { defaultStart: string }) {
  return (
    <StatefulForm action={createBooking}>
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="bk-barcode" className={labelCls}>Item barcode</label>
            <input id="bk-barcode" name="barcode" autoComplete="off" placeholder="LIB-001031" className={`${fieldCls} font-mono`} />
          </div>
          <div>
            <label htmlFor="bk-email" className={labelCls}>Member email</label>
            <input id="bk-email" name="email" type="email" autoComplete="off" placeholder="member@example.edu" className={fieldCls} />
          </div>
          <div>
            <label htmlFor="bk-start" className={labelCls}>From</label>
            <input id="bk-start" name="startAt" type="datetime-local" defaultValue={defaultStart} className={fieldCls} />
          </div>
          <div>
            <label htmlFor="bk-end" className={labelCls}>Until</label>
            <input id="bk-end" name="endAt" type="datetime-local" className={fieldCls} />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="bk-note" className={labelCls}>Note (optional)</label>
            <input id="bk-note" name="note" placeholder="What it is for" className={fieldCls} />
          </div>
          {state.ok === false && state.message && (
            <p className="sm:col-span-2 text-sm text-red-700">{state.message}</p>
          )}
          <div className="sm:col-span-2">
            <SubmitButton pendingLabel="Booking…">Book this item</SubmitButton>
          </div>
        </div>
      )}
    </StatefulForm>
  );
}

export function ConfirmBookingButton({ bookingId }: { bookingId: string }) {
  return (
    <ActionButton action={confirmBooking} fields={{ bookingId }} className="!px-3 !py-1.5 text-xs" pendingLabel="…">
      Confirm
    </ActionButton>
  );
}

export function CollectBookingButton({ bookingId, who }: { bookingId: string; who: string }) {
  return (
    <ActionButton action={collectBooking} fields={{ bookingId }} className="!px-3 !py-1.5 text-xs" pendingLabel="…">
      Hand to {who}
    </ActionButton>
  );
}

export function CancelBookingButton({ bookingId, label }: { bookingId: string; label: string }) {
  return (
    <ActionButton
      action={cancelBooking}
      fields={{ bookingId }}
      variant="outline"
      className="!px-3 !py-1.5 text-xs text-red-700"
      pendingLabel="…"
      confirm={`Cancel the booking of ${label}? That window becomes free again.`}
    >
      Cancel
    </ActionButton>
  );
}

export function NoShowButton({ bookingId }: { bookingId: string }) {
  return (
    <ActionButton
      action={markNoShow}
      fields={{ bookingId }}
      variant="outline"
      className="!px-3 !py-1.5 text-xs"
      pendingLabel="…"
    >
      Not collected
    </ActionButton>
  );
}
