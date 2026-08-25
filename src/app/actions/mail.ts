"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit } from "@/lib/audit";
import { drainMailQueue, retryFailedMail } from "@/lib/mail/queue";
import { dispositionFor, sendingEnabled } from "@/lib/mail/policy";
import { resolveTransport } from "@/lib/mail/transport";

/**
 * The three things an administrator needs to be able to do to the outbox
 * without a database client: push it now, put failures back, and prove the
 * configuration works before trusting it with a member's address.
 *
 * All three sit behind the BATCH area, which is where the outbox is displayed.
 */

/** Drain the queue on demand, rather than waiting for the ten-minute job. */
export async function sendQueuedMail(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "BATCH"))
    return { ok: false, message: "You don't have permission to run batch processes." };

  const result = await drainMailQueue();
  revalidatePath("/admin/batch");

  if (result.skipped) {
    return { ok: false, message: `Nothing sent. ${result.skipped}` };
  }

  const parts = [
    `${result.sent} sent`,
    result.retrying ? `${result.retrying} will retry` : "",
    result.failed ? `${result.failed} failed` : "",
    result.suppressed ? `${result.suppressed} suppressed` : "",
    result.expired ? `${result.expired} expired` : "",
  ].filter(Boolean);

  if (result.attempted + result.expired + result.reaped === 0) {
    return { ok: true, message: "Outbox is empty; nothing was waiting to go out." };
  }

  await audit({
    action: "mail.drain",
    summary: `Outbox drained by hand via ${result.transport}: ${parts.join(", ")}`,
    entity: "MailQueue",
  });
  return { ok: true, message: `Outbox via ${result.transport}: ${parts.join(", ")}.` };
}

/** Put failed and suppressed rows back in the queue after fixing the cause. */
export async function retryOutbox(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "BATCH"))
    return { ok: false, message: "You don't have permission to run batch processes." };

  const count = await retryFailedMail();
  revalidatePath("/admin/batch");
  if (count === 0) return { ok: true, message: "Nothing to retry." };

  await audit({
    action: "mail.retry",
    summary: `Requeued ${count} failed or suppressed message${count === 1 ? "" : "s"}`,
    entity: "MailQueue",
  });
  return { ok: true, message: `Requeued ${count} message${count === 1 ? "" : "s"}.` };
}

/**
 * Send one message to the signed-in administrator's own address.
 *
 * Deliberately not free choice of recipient. The question this answers is "is
 * delivery configured correctly", and answering it should never be a way to
 * mail an arbitrary address from the library's domain.
 */
export async function sendTestMail(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "BATCH"))
    return { ok: false, message: "You don't have permission to run batch processes." };
  if (!admin?.email) return { ok: false, message: "Your account has no email address." };

  const enabled = sendingEnabled();
  if (!enabled.enabled) return { ok: false, message: `Not sent. ${enabled.reason}` };

  const disposition = dispositionFor(admin.email);
  if (!disposition.send) return { ok: false, message: `Not sent. ${disposition.reason}` };

  const transport = resolveTransport();
  if (transport.name === "dry-run") {
    return {
      ok: false,
      message:
        "No provider is configured, so there is nothing to test. Set MAIL_API_KEY and MAIL_FROM.",
    };
  }

  const outcome = await transport.send({
    to: admin.email,
    toName: admin.name,
    subject: "DLS Admin: delivery test",
    body:
      `This is a test message from DLS Admin, sent by ${admin.name}.\n\n` +
      `If it arrived, outbound mail is configured correctly and queued notices ` +
      `will reach members.\n\nTransport: ${transport.name}`,
  });

  // Recorded in the outbox like any other message, so the trail of what this
  // system has sent stays complete.
  await prisma.mailQueue.create({
    data: {
      toEmail: admin.email,
      toName: admin.name,
      subject: "DLS Admin: delivery test",
      body: "Delivery test requested from the batch console.",
      template: "TEST",
      status: outcome.ok ? "SENT" : "FAILED",
      attempts: 1,
      lastAttemptAt: new Date(),
      sentAt: outcome.ok ? new Date() : null,
      providerId: outcome.ok ? (outcome.providerId ?? null) : null,
      lastError: outcome.ok ? null : outcome.error,
      transport: transport.name,
    },
  });

  await audit({
    action: "mail.test",
    summary: outcome.ok
      ? `Delivery test to ${admin.email} accepted by ${transport.name}`
      : `Delivery test to ${admin.email} failed: ${outcome.error}`,
    entity: "MailQueue",
  });
  revalidatePath("/admin/batch");

  return outcome.ok
    ? { ok: true, message: `Test message accepted by ${transport.name}. Check ${admin.email}.` }
    : { ok: false, message: `Provider refused it: ${outcome.error}` };
}
