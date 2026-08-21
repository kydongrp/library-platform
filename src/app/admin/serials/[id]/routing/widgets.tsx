"use client";

import { StatefulForm, SubmitButton, ActionButton } from "@/components/forms";
import {
  addRoutingSubscriber,
  removeRoutingSubscriber,
  moveRoutingSubscriber,
  toggleAlertOnly,
  startRouting,
  routeOut,
  routeIn,
  sendIssueAlerts,
} from "@/app/actions/routing";

const fieldCls =
  "rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelCls = "mb-1 block text-xs font-medium text-muted-foreground";

export function AddSubscriberForm({ serialId }: { serialId: string }) {
  return (
    <StatefulForm action={addRoutingSubscriber}>
      {(state) => (
        <div className="grid gap-3">
          <input type="hidden" name="serialId" value={serialId} />
          <div>
            <label htmlFor="rs-email" className={labelCls}>
              Member email
            </label>
            <input
              id="rs-email"
              name="email"
              type="email"
              placeholder="member@example.edu"
              autoComplete="off"
              className={`w-full ${fieldCls}`}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="alertOnly" className="h-4 w-4 rounded border-border" />
            Alert only — tell them an issue arrived, but do not hand them the copy
          </label>
          {state.ok === false && state.message && (
            <p className="text-sm text-red-700">{state.message}</p>
          )}
          <div>
            <SubmitButton pendingLabel="Adding…">Add to list</SubmitButton>
          </div>
        </div>
      )}
    </StatefulForm>
  );
}

export function SubscriberControls({
  id,
  alertOnly,
  isFirst,
  isLast,
  name,
}: {
  id: string;
  alertOnly: boolean;
  isFirst: boolean;
  isLast: boolean;
  name: string;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {!alertOnly && (
        <>
          <ActionButton
            action={moveRoutingSubscriber}
            fields={{ id, dir: "up" }}
            variant="ghost"
            className={`!px-1.5 !py-0.5 text-xs ${isFirst ? "opacity-30" : ""}`}
            pendingLabel="…"
          >
            ↑
          </ActionButton>
          <ActionButton
            action={moveRoutingSubscriber}
            fields={{ id, dir: "down" }}
            variant="ghost"
            className={`!px-1.5 !py-0.5 text-xs ${isLast ? "opacity-30" : ""}`}
            pendingLabel="…"
          >
            ↓
          </ActionButton>
        </>
      )}
      <ActionButton
        action={toggleAlertOnly}
        fields={{ id }}
        variant="ghost"
        className="!px-2 !py-0.5 text-xs"
        pendingLabel="…"
      >
        {alertOnly ? "Route to them" : "Alert only"}
      </ActionButton>
      <ActionButton
        action={removeRoutingSubscriber}
        fields={{ id }}
        variant="ghost"
        className="!px-2 !py-0.5 text-xs text-red-700"
        pendingLabel="…"
        confirm={`Remove ${name} from this list?`}
      >
        Remove
      </ActionButton>
    </span>
  );
}

export function StartRoutingButton({ issueId }: { issueId: string }) {
  return (
    <ActionButton action={startRouting} fields={{ issueId }} className="!px-3 !py-1.5 text-xs" pendingLabel="Starting…">
      Start routing
    </ActionButton>
  );
}

export function RouteOutButton({ issueId, to }: { issueId: string; to: string }) {
  return (
    <ActionButton action={routeOut} fields={{ issueId }} className="!px-3 !py-1.5 text-xs" pendingLabel="…">
      Route out to {to}
    </ActionButton>
  );
}

export function RouteInButton({ issueId, from }: { issueId: string; from: string }) {
  return (
    <ActionButton action={routeIn} fields={{ issueId }} className="!px-3 !py-1.5 text-xs" pendingLabel="…">
      Route in from {from}
    </ActionButton>
  );
}

export function SendAlertsButton({ issueId, count }: { issueId: string; count: number }) {
  return (
    <ActionButton
      action={sendIssueAlerts}
      fields={{ issueId }}
      variant="ghost"
      className="!px-3 !py-1.5 text-xs"
      pendingLabel="Sending…"
      confirm={`Notify ${count} ${count === 1 ? "person" : "people"} that this issue has arrived?`}
    >
      ✉ Send arrival alerts
    </ActionButton>
  );
}
