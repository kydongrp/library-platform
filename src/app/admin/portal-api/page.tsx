import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import {
  revokeApiClient,
  toggleWebhook,
  deleteWebhook,
  testWebhook,
} from "@/app/actions/portal-api";
import { WEBHOOK_EVENTS } from "@/lib/webhooks";
import { formatDate } from "@/lib/format";
import { CreateClientForm, CreateWebhookForm } from "./widgets";

export const dynamic = "force-dynamic";

const timeOf = (d: Date) =>
  `${formatDate(d)} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;

const ENDPOINTS = [
  { method: "GET", path: "/api/portal/v1/ping", note: "credential check" },
  { method: "GET", path: "/api/portal/v1/resources", note: "search: q, category, type, provider, updatedSince, sort, page, pageSize" },
  { method: "GET", path: "/api/portal/v1/resources/{id}", note: "full record + aggregate rating" },
  { method: "GET", path: "/api/portal/v1/editors-picks", note: "the curated shelf, newest first" },
];

export default async function PortalApiPage() {
  const admin = await requireAdminView("ADMIN");
  const editable = canEdit(admin, "ADMIN");

  const [clients, webhooks, deliveries] = await Promise.all([
    prisma.apiClient.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.webhook.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.webhookDelivery.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { webhook: { select: { url: true } } },
    }),
  ]);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Portal API</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          The integration surface for the Learner Portal: a read-only, versioned
          JSON API (Application Programming Interface) over the catalogue,
          availability, and Editor&apos;s Picks — plus signed webhooks that push
          changes out, so the portal never has to poll. Keys and webhooks are
          Administrators-only.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* API clients */}
        <Card className="p-5">
          <h2 className="mb-1 font-display text-lg font-semibold">API keys</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Sent as <code>Authorization: Bearer dls_live_…</code>. Only a hash is
            stored — the full key is shown once, at creation.
          </p>
          {clients.length === 0 ? (
            <EmptyState title="No API keys yet" description="Create one to let the portal call the API." />
          ) : (
            <ul className="divide-y divide-border">
              {clients.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{c.name}</p>
                    <p className="text-xs text-muted-foreground">
                      <code>{c.keyPrefix}…</code> · created {formatDate(c.createdAt)} by {c.createdBy}
                      {c.lastUsedAt ? ` · last used ${timeOf(c.lastUsedAt)}` : " · never used"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {c.status === "ACTIVE" ? (
                      <Badge tone="success">Active</Badge>
                    ) : (
                      <Badge tone="danger">Revoked</Badge>
                    )}
                    {editable && c.status === "ACTIVE" && (
                      <ActionButton action={revokeApiClient} fields={{ id: c.id }} variant="outline"
                        className="!px-2 !py-1 text-xs text-red-700" pendingLabel="…"
                        confirm={`Revoke "${c.name}"? Requests with this key will get 403 immediately.`}>
                        Revoke
                      </ActionButton>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {editable && (
            <div className="mt-4 border-t border-border pt-4">
              <CreateClientForm />
            </div>
          )}
        </Card>

        {/* Webhooks */}
        <Card className="p-5">
          <h2 className="mb-1 font-display text-lg font-semibold">Webhooks</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            POSTs signed with <code>X-DLS-Signature: sha256=HMAC(secret, body)</code>.
            Single attempt per event; use <code>updatedSince</code> polling as the
            catch-up path.
          </p>
          {webhooks.length === 0 ? (
            <EmptyState title="No webhooks" description="Register the portal's endpoint to push changes to it." />
          ) : (
            <ul className="divide-y divide-border">
              {webhooks.map((w) => (
                <li key={w.id} className="py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium">{w.url}</p>
                    {w.status === "ACTIVE" ? (
                      <Badge tone="success">Active</Badge>
                    ) : (
                      <Badge tone="muted">Disabled</Badge>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {w.events.length === 0 ? (
                      <Badge tone="neutral">all events</Badge>
                    ) : (
                      w.events.map((e) => <Badge key={e} tone="neutral">{e}</Badge>)
                    )}
                    <span className="text-xs text-muted-foreground">
                      by {w.createdBy} · {formatDate(w.createdAt)}
                    </span>
                  </div>
                  {editable && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <ActionButton action={testWebhook} fields={{ id: w.id }} variant="ghost"
                        className="!px-2 !py-1 text-xs" pendingLabel="Sending…">
                        ⚡ Send test
                      </ActionButton>
                      <ActionButton action={toggleWebhook} fields={{ id: w.id }} variant="ghost"
                        className="!px-2 !py-1 text-xs" pendingLabel="…">
                        {w.status === "ACTIVE" ? "Disable" : "Enable"}
                      </ActionButton>
                      <ActionButton action={deleteWebhook} fields={{ id: w.id }} variant="ghost"
                        className="!px-2 !py-1 text-xs text-red-700" pendingLabel="…"
                        confirm="Delete this webhook and its delivery log?">
                        Delete
                      </ActionButton>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {editable && (
            <div className="mt-4 border-t border-border pt-4">
              <CreateWebhookForm events={WEBHOOK_EVENTS} />
            </div>
          )}
        </Card>
      </div>

      {/* Delivery log */}
      <Card className="mt-6 p-5">
        <h2 className="mb-3 font-display text-lg font-semibold">Recent webhook deliveries</h2>
        {deliveries.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">
            No deliveries yet — they appear here when catalogue or Editor&apos;s Pick events fire.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {deliveries.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  {d.ok ? <Badge tone="success">✓ {d.statusCode}</Badge> : <Badge tone="danger">✕ {d.error ?? d.statusCode}</Badge>}
                  <code className="text-xs">{d.event}</code>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">{d.webhook.url}</span>
                </div>
                <span className="text-xs text-muted-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {d.durationMs != null ? `${d.durationMs}ms · ` : ""}{timeOf(d.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Docs */}
      <Card className="mt-6 p-5">
        <h2 className="mb-1 font-display text-lg font-semibold">Endpoints</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Read-only JSON. Server-to-server only (no CORS); responses are
          <code> {"{ data, meta }"}</code>, errors <code>{"{ error: { code, message } }"}</code>.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {ENDPOINTS.map((e) => (
                <tr key={e.path} className="border-b border-border last:border-0">
                  <td className="py-2 pr-3 font-mono text-xs font-semibold">{e.method}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{e.path}</td>
                  <td className="py-2 text-xs text-muted-foreground">{e.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mb-1 mt-4 text-xs font-medium text-muted-foreground">Try it</p>
        <pre className="overflow-x-auto rounded-lg bg-stone-900 p-3 text-xs leading-relaxed text-stone-100">
{`curl -H "Authorization: Bearer dls_live_…" \\
  "https://library.zillearn.com/api/portal/v1/resources?q=power&type=EBOOK&pageSize=5"`}
        </pre>
        <p className="mb-1 mt-3 text-xs font-medium text-muted-foreground">Verify a webhook signature (Node)</p>
        <pre className="overflow-x-auto rounded-lg bg-stone-900 p-3 text-xs leading-relaxed text-stone-100">
{`const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
const valid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-dls-signature"]));`}
        </pre>
      </Card>
    </div>
  );
}
