// Outbound webhooks: the push half of the Portal API. Mutations call
// emitEventAfter(event, data). Delivery runs after the response is sent
// (next/server after()), signed with each webhook's shared secret, and can
// never fail the mutation that triggered it.
//
// Signature: X-DLS-Signature: sha256=<hex HMAC-SHA256 of the raw body>.
// Consumers verify by recomputing the HMAC with their secret.
//
// Webhook URLs are validated against the SSRF blocklist AT CREATION (see
// actions/portal-api.ts). Delivery trusts the stored URL, which also lets
// local test listeners exercise the pipeline in development.

import { createHmac } from "crypto";
import { after } from "next/server";
import { prisma } from "@/lib/db";

export const WEBHOOK_EVENTS = [
  "editors_pick.added",
  "editors_pick.removed",
  "resource.created",
  "resource.updated",
  "resource.deleted",
  "resources.imported",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const DELIVERY_TIMEOUT_MS = 5_000;
const KEEP_DELIVERIES_PER_HOOK = 25;
const ERROR_MAX = 300;

export function signPayload(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export type EmitResult = { webhooks: number; delivered: number };

type HookRow = { id: string; url: string; secret: string };

/** POST one signed payload to one webhook and record the attempt. */
async function deliverOne(hook: HookRow, event: string, body: string): Promise<boolean> {
  const started = Date.now();
  let ok = false;
  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "DLS-Admin-Webhook/1.0",
        "x-dls-event": event,
        "x-dls-signature": signPayload(hook.secret, body),
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      redirect: "manual", // a redirect would re-target the signed POST
    });
    statusCode = res.status;
    ok = res.ok;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, ERROR_MAX) : "delivery failed";
  }

  // Bookkeeping never throws out of the delivery.
  try {
    await prisma.webhookDelivery.create({
      data: { webhookId: hook.id, event, ok, statusCode, error, durationMs: Date.now() - started },
    });
    const stale = await prisma.webhookDelivery.findMany({
      where: { webhookId: hook.id },
      orderBy: { createdAt: "desc" },
      skip: KEEP_DELIVERIES_PER_HOOK,
      select: { id: true },
    });
    if (stale.length > 0)
      await prisma.webhookDelivery.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  } catch (e) {
    console.error("webhook bookkeeping failed", e);
  }
  return ok;
}

/** Deliver one event to every ACTIVE webhook subscribed to it. */
export async function emitEvent(event: WebhookEvent, data: unknown): Promise<EmitResult> {
  const hooks = await prisma.webhook.findMany({ where: { status: "ACTIVE" } });
  const subscribed = hooks.filter((h) => h.events.length === 0 || h.events.includes(event));
  if (subscribed.length === 0) return { webhooks: 0, delivered: 0 };

  const body = JSON.stringify({ event, at: new Date().toISOString(), data });
  const results = await Promise.allSettled(subscribed.map((h) => deliverOne(h, event, body)));
  const delivered = results.filter((r) => r.status === "fulfilled" && r.value).length;
  return { webhooks: subscribed.length, delivered };
}

/** Signed test ping to a single webhook (regardless of its subscriptions). */
export async function sendTestDelivery(webhookId: string): Promise<{ ok: boolean }> {
  const hook = await prisma.webhook.findUnique({ where: { id: webhookId } });
  if (!hook) return { ok: false };
  const body = JSON.stringify({
    event: "test.ping",
    at: new Date().toISOString(),
    data: { message: "DLS Admin webhook test delivery" },
  });
  return { ok: await deliverOne(hook, "test.ping", body) };
}

/**
 * Fire-and-forget from a server action / route handler: runs after the
 * response is sent. Falls back to a detached promise outside a request
 * scope (tsx scripts, tests).
 */
export function emitEventAfter(event: WebhookEvent, data: unknown): void {
  const run = () =>
    emitEvent(event, data).catch((e) => console.error(`webhook emit ${event} failed`, e));
  try {
    after(run);
  } catch {
    void run();
  }
}
