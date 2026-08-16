"use server";

import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit } from "@/lib/audit";
import { generateApiKey } from "@/lib/portal-auth";
import { isBlockedHost } from "@/lib/net";
import { WEBHOOK_EVENTS, sendTestDelivery, type WebhookEvent } from "@/lib/webhooks";

// Integration credentials are Administrators-only (ADMIN area), like Admin
// Settings. Server actions are directly invocable endpoints — re-check here.
async function requireApiAdmin(): Promise<{ name: string } | null> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "ADMIN")) return null;
  return { name: admin!.name };
}

const NO_PERMISSION = { ok: false as const, message: "Only Administrators can manage Portal API access." };
const clip = (v: FormDataEntryValue | null, n: number) => String(v ?? "").trim().slice(0, n);

/* ---------- API clients ---------- */

export async function createApiClient(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireApiAdmin();
  if (!admin) return NO_PERMISSION;

  const name = clip(formData.get("name"), 80);
  if (!name) return { ok: false, message: "Give the key a name (e.g. \"Learner Portal (prod)\")." };

  const { key, keyPrefix, keyHash } = generateApiKey();
  const client = await prisma.apiClient.create({
    data: { name, keyPrefix, keyHash, createdBy: admin.name },
  });
  await audit({
    action: "portal.client.create",
    summary: `Created Portal API key "${name}" (${keyPrefix}…)`,
    entity: "ApiClient",
    entityId: client.id,
  });
  revalidatePath("/admin/portal-api");
  // The one and only time the full key is shown — only its hash is stored.
  return {
    ok: true,
    message: `Key created — copy it now, it won't be shown again: ${key}`,
  };
}

export async function revokeApiClient(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireApiAdmin();
  if (!admin) return NO_PERMISSION;

  const id = clip(formData.get("id"), 40);
  const r = await prisma.apiClient.updateMany({
    where: { id, status: "ACTIVE" },
    data: { status: "REVOKED" },
  });
  if (r.count === 0) return { ok: false, message: "That key is gone or already revoked." };
  await audit({
    action: "portal.client.revoke",
    summary: "Revoked a Portal API key",
    entity: "ApiClient",
    entityId: id,
  });
  revalidatePath("/admin/portal-api");
  return { ok: true, message: "Key revoked — requests with it now get 403." };
}

/* ---------- Webhooks ---------- */

export async function createWebhook(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireApiAdmin();
  if (!admin) return NO_PERMISSION;

  const url = clip(formData.get("url"), 2000);
  if (!/^https?:\/\//i.test(url)) return { ok: false, message: "The endpoint must be an http(s) URL." };
  if (isBlockedHost(url))
    return { ok: false, message: "That host is not allowed (internal/private addresses are blocked)." };

  const events = formData
    .getAll("events")
    .map(String)
    .filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e));

  const secret = "whsec_" + randomBytes(24).toString("hex");
  const hook = await prisma.webhook.create({
    data: { url, secret, events, createdBy: admin.name },
  });
  await audit({
    action: "portal.webhook.create",
    summary: `Registered webhook ${url}${events.length ? ` (${events.join(", ")})` : " (all events)"}`,
    entity: "Webhook",
    entityId: hook.id,
  });
  revalidatePath("/admin/portal-api");
  return {
    ok: true,
    message: `Webhook registered. Signing secret — copy it now: ${secret}`,
  };
}

export async function toggleWebhook(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireApiAdmin();
  if (!admin) return NO_PERMISSION;

  const id = clip(formData.get("id"), 40);
  const hook = await prisma.webhook.findUnique({ where: { id } });
  if (!hook) return { ok: false, message: "That webhook no longer exists." };
  const status = hook.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
  await prisma.webhook.update({ where: { id }, data: { status } });
  await audit({
    action: "portal.webhook.toggle",
    summary: `${status === "ACTIVE" ? "Enabled" : "Disabled"} webhook ${hook.url}`,
    entity: "Webhook",
    entityId: id,
  });
  revalidatePath("/admin/portal-api");
  return { ok: true, message: status === "ACTIVE" ? "Webhook enabled." : "Webhook disabled — no deliveries until re-enabled." };
}

export async function deleteWebhook(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireApiAdmin();
  if (!admin) return NO_PERMISSION;

  const id = clip(formData.get("id"), 40);
  const hook = await prisma.webhook.findUnique({ where: { id } });
  if (!hook) return { ok: false, message: "That webhook no longer exists." };
  await prisma.webhook.delete({ where: { id } }); // deliveries cascade
  await audit({
    action: "portal.webhook.delete",
    summary: `Deleted webhook ${hook.url}`,
    entity: "Webhook",
    entityId: id,
  });
  revalidatePath("/admin/portal-api");
  return { ok: true, message: "Webhook deleted." };
}

export async function testWebhook(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireApiAdmin();
  if (!admin) return NO_PERMISSION;

  const id = clip(formData.get("id"), 40);
  const result = await sendTestDelivery(id);
  await audit({
    action: "portal.webhook.test",
    summary: `Sent test delivery to webhook (${result.ok ? "succeeded" : "failed"})`,
    entity: "Webhook",
    entityId: id,
  });
  revalidatePath("/admin/portal-api");
  return result.ok
    ? { ok: true, message: "Test delivery succeeded (2xx)." }
    : { ok: false, message: "Test delivery failed — see the delivery log below." };
}
