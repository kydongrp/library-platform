import { NextResponse } from "next/server";
import { drainMailQueue } from "@/lib/mail/queue";
import { audit } from "@/lib/audit";
import { denyUnlessCron } from "../_guard";

/**
 * Work the outbox, scheduled by Vercel Cron (see vercel.json).
 *
 * The other four jobs run once a night because what they produce is a daily
 * fact. This one runs every ten minutes because what it carries is not: a
 * hold-available notice is worth little the next morning, and a member who has
 * just been told an item is waiting expects the mail before they walk over.
 *
 * The drain is idempotent and claims rows individually, so two runs
 * overlapping is a normal condition rather than a fault, and a run that
 * produced nothing is not worth an audit entry.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const denied = denyUnlessCron(request);
  if (denied) return denied;

  const result = await drainMailQueue();

  // Audit what left the building or failed to, and stay quiet otherwise. The
  // audit trail is read by people looking for what happened to one member's
  // notice, so a nightly wall of "nothing to do" would bury the answer.
  const noteworthy = result.sent + result.failed + result.suppressed + result.expired;
  if (noteworthy > 0) {
    const parts = [
      `${result.sent} sent`,
      result.failed ? `${result.failed} failed` : "",
      result.suppressed ? `${result.suppressed} suppressed` : "",
      result.expired ? `${result.expired} expired` : "",
      result.retrying ? `${result.retrying} retrying` : "",
    ].filter(Boolean);
    await audit({
      actor: { name: "cron" },
      action: "mail.drain",
      summary: `Outbox via ${result.transport}: ${parts.join(", ")}`,
      entity: "MailQueue",
    });
  }

  return NextResponse.json({ ok: true, mail: result });
}
