"use client";

import { StatefulForm, SubmitButton } from "@/components/forms";
import { createApiClient, createWebhook } from "@/app/actions/portal-api";

const fieldCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
const labelCls = "mb-1 block text-xs font-medium text-muted-foreground";

/** Renders a success message, isolating the one-time secret into a copyable code block. */
function SecretReveal({ message }: { message: string }) {
  const idx = message.indexOf(": ");
  if (idx === -1) return <p className="text-sm text-green-700">{message}</p>;
  const text = message.slice(0, idx + 1);
  const secret = message.slice(idx + 2);
  return (
    <div className="rounded-lg border border-green-200 bg-green-50 p-3">
      <p className="text-sm text-green-800">{text}</p>
      <code className="mt-1 block select-all break-all rounded bg-white px-2 py-1.5 font-mono text-xs ring-1 ring-green-200">
        {secret}
      </code>
    </div>
  );
}

export function CreateClientForm() {
  return (
    <StatefulForm action={createApiClient}>
      {(state) => (
        <div className="grid gap-3">
          <div>
            <label htmlFor="ac-name" className={labelCls}>Client name *</label>
            <input id="ac-name" name="name" required maxLength={80}
              placeholder={'e.g. "Learner Portal (prod)"'} className={fieldCls} />
          </div>
          {state.ok === false && state.message && (
            <p className="text-sm text-red-700">{state.message}</p>
          )}
          {state.ok === true && state.message && <SecretReveal message={state.message} />}
          <div>
            <SubmitButton pendingLabel="Creating…">＋ Create API key</SubmitButton>
          </div>
        </div>
      )}
    </StatefulForm>
  );
}

export function CreateWebhookForm({ events }: { events: readonly string[] }) {
  return (
    <StatefulForm action={createWebhook}>
      {(state) => (
        <div className="grid gap-3">
          <div>
            <label htmlFor="wh-url" className={labelCls}>Endpoint URL *</label>
            <input id="wh-url" name="url" required type="url"
              placeholder="https://portal.example.com/hooks/dls" className={fieldCls} />
          </div>
          <fieldset>
            <legend className={labelCls}>Events (none checked = all events)</legend>
            <div className="grid grid-cols-2 gap-1.5">
              {events.map((e) => (
                <label key={e} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="events" value={e}
                    className="h-4 w-4 rounded border-border accent-primary" />
                  <code className="text-xs">{e}</code>
                </label>
              ))}
            </div>
          </fieldset>
          {state.ok === false && state.message && (
            <p className="text-sm text-red-700">{state.message}</p>
          )}
          {state.ok === true && state.message && <SecretReveal message={state.message} />}
          <div>
            <SubmitButton pendingLabel="Registering…" variant="outline">⇌ Register webhook</SubmitButton>
          </div>
        </div>
      )}
    </StatefulForm>
  );
}
