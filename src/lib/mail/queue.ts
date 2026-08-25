import { prisma } from "@/lib/db";
import { resolveTransport, type MailTransport } from "./transport";
import {
  MAX_ATTEMPTS,
  batchSize,
  dispositionFor,
  maxAgeHours,
  nextAttemptAfter,
  sendingEnabled,
} from "./policy";

/**
 * Draining the outbox.
 *
 * Nothing sends inline. `notify()` writes a QUEUED row and returns, and this
 * runs on a schedule, for two reasons: a checkout must not wait on somebody
 * else's API, and a provider being down must not turn into a failed checkout.
 *
 * The awkward part of any queue on serverless is that two runs can overlap.
 * Rows are therefore claimed one at a time with a conditional update, so a row
 * can only be taken by whichever run gets there first. A claim that dies
 * mid-flight leaves a row in SENDING, which the reaper below returns to the
 * queue after a grace period.
 */

/** A row left SENDING for longer than this is assumed to be from a dead run. */
const STUCK_MINUTES = 15;

export type DrainSummary = {
  attempted: number;
  sent: number;
  suppressed: number;
  failed: number;
  retrying: number;
  expired: number;
  reaped: number;
  transport: string;
  /** Present when the run sent nothing on purpose. */
  skipped?: string;
};

const EMPTY: Omit<DrainSummary, "transport" | "skipped"> = {
  attempted: 0,
  sent: 0,
  suppressed: 0,
  failed: 0,
  retrying: 0,
  expired: 0,
  reaped: 0,
};

/**
 * Return rows abandoned by a run that died between claiming and finishing.
 *
 * Their attempt was already counted, which is correct: the message may well
 * have reached the provider before the process ended, and counting it keeps a
 * row that reliably kills its runner from retrying for ever.
 */
async function reapStuck(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_MINUTES * 60_000);
  const { count } = await prisma.mailQueue.updateMany({
    where: { status: "SENDING", lastAttemptAt: { lt: cutoff } },
    data: { status: "QUEUED", lastError: "Reclaimed after a run ended mid-send." },
  });
  return count;
}

/**
 * Abandon anything that has waited too long to be worth sending.
 *
 * Runs whether or not sending is enabled, so a queue left disabled for a month
 * does not empty itself into members' inboxes on the day someone turns it on.
 */
async function expireStale(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - maxAgeHours() * 3_600_000);
  const { count } = await prisma.mailQueue.updateMany({
    where: { status: "QUEUED", createdAt: { lt: cutoff } },
    data: {
      status: "EXPIRED",
      lastError: `Older than ${maxAgeHours()}h when the queue next ran; not sent.`,
    },
  });
  return count;
}

/** Claim one row, or report that another run got there first. */
async function claim(id: string, now: Date): Promise<boolean> {
  const { count } = await prisma.mailQueue.updateMany({
    where: { id, status: "QUEUED" },
    data: { status: "SENDING", lastAttemptAt: now, attempts: { increment: 1 } },
  });
  return count === 1;
}

async function attempt(
  row: { id: string; toEmail: string; toName: string; subject: string; body: string; attempts: number },
  transport: MailTransport,
  now: Date,
  summary: typeof EMPTY,
): Promise<void> {
  const disposition = dispositionFor(row.toEmail);
  if (!disposition.send) {
    await prisma.mailQueue.update({
      where: { id: row.id },
      data: { status: "SUPPRESSED", lastError: disposition.reason, transport: transport.name },
    });
    summary.suppressed++;
    return;
  }

  const outcome = await transport.send({
    to: row.toEmail,
    toName: row.toName,
    subject: row.subject,
    body: row.body,
  });

  if (outcome.ok) {
    await prisma.mailQueue.update({
      where: { id: row.id },
      data: {
        status: "SENT",
        sentAt: now,
        providerId: outcome.providerId ?? null,
        transport: transport.name,
        lastError: null,
        nextAttemptAt: null,
      },
    });
    summary.sent++;
    return;
  }

  // attempts was incremented when the row was claimed, so this is the count
  // including the attempt that just failed.
  const used = row.attempts + 1;
  const giveUp = !outcome.retryable || used >= MAX_ATTEMPTS;
  await prisma.mailQueue.update({
    where: { id: row.id },
    data: {
      status: giveUp ? "FAILED" : "QUEUED",
      lastError: outcome.retryable
        ? outcome.error
        : `${outcome.error} (not retryable)`,
      nextAttemptAt: giveUp ? null : nextAttemptAfter(used, now),
      transport: transport.name,
    },
  });
  if (giveUp) summary.failed++;
  else summary.retrying++;
}

/**
 * Work the queue once.
 *
 * Safe to call concurrently and safe to call when sending is switched off: in
 * that case it still reaps and expires, so the housekeeping that keeps the
 * queue honest does not depend on a provider being configured.
 */
export async function drainMailQueue(now: Date = new Date()): Promise<DrainSummary> {
  const transport = resolveTransport();
  const summary = { ...EMPTY };

  summary.reaped = await reapStuck(now);
  summary.expired = await expireStale(now);

  const enabled = sendingEnabled();
  if (!enabled.enabled) {
    return { ...summary, transport: transport.name, skipped: enabled.reason };
  }

  const candidates = await prisma.mailQueue.findMany({
    where: {
      status: "QUEUED",
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: batchSize(),
    select: {
      id: true,
      toEmail: true,
      toName: true,
      subject: true,
      body: true,
      attempts: true,
    },
  });

  for (const row of candidates) {
    if (!(await claim(row.id, now))) continue;
    summary.attempted++;
    try {
      await attempt(row, transport, now, summary);
    } catch (error) {
      // A throw here means our own code failed, not the provider. Put the row
      // back rather than losing it in SENDING until the reaper notices.
      await prisma.mailQueue.update({
        where: { id: row.id },
        data: {
          status: "QUEUED",
          nextAttemptAt: nextAttemptAfter(row.attempts + 1, now),
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      summary.retrying++;
    }
  }

  return { ...summary, transport: transport.name };
}

/**
 * Put failed or suppressed rows back in the queue, clearing their backoff.
 *
 * The admin-facing repair: fix the configuration, then press retry, rather
 * than editing rows by hand. Expired rows are excluded on purpose, since they
 * were abandoned for being stale and retrying them reintroduces exactly the
 * flood that expiry exists to prevent.
 */
export async function retryFailedMail(ids?: string[]): Promise<number> {
  const { count } = await prisma.mailQueue.updateMany({
    where: {
      status: { in: ["FAILED", "SUPPRESSED"] },
      ...(ids && ids.length ? { id: { in: ids } } : {}),
    },
    data: { status: "QUEUED", attempts: 0, nextAttemptAt: null, lastError: null },
  });
  return count;
}

/** Counts by status, for the outbox panel. */
export async function outboxCounts(): Promise<Record<string, number>> {
  const rows = await prisma.mailQueue.groupBy({ by: ["status"], _count: { _all: true } });
  return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
}
