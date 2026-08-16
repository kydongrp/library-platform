"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { policyFor } from "@/lib/policies";
import { notify } from "@/lib/templates";
import { formatDate, daysUntil } from "@/lib/format";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { runSftpFetch } from "@/lib/ingest";
import { audit } from "@/lib/audit";
import { isBlockedHost } from "@/lib/net";

const DAY = 24 * 60 * 60 * 1000;
const PREDUE_DAYS = 2; // notify when a loan is due within this many days
const INACTIVE_MONTHS = 6;

/**
 * End-of-day batch (SDD: EodProcess). Generates templated notifications:
 * predue, overdue, cancel expired READY reservations, welcome, inactive.
 * Idempotent per day — a notification of the same type for the same subject
 * is not repeated within 24h.
 */
export async function runEodProcess(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "BATCH"))
    return { ok: false, message: "You don't have permission to run batch processes." };

  const since = new Date(Date.now() - 1 * DAY);
  const recent = await prisma.notification.findMany({
    where: { createdAt: { gte: since } },
    select: { type: true, memberId: true, title: true },
  });
  const alreadySent = new Set(recent.map((n) => `${n.type}:${n.memberId}:${n.title}`));
  const counts = { predue: 0, overdue: 0, cancelled: 0, welcome: 0, inactive: 0 };
  const now = new Date();

  // 1. Predue + overdue on active loans.
  const activeLoans = await prisma.loan.findMany({
    where: { status: "ACTIVE" },
    include: { member: true, resource: true },
  });
  for (const loan of activeLoans) {
    const d = daysUntil(loan.dueAt);
    const vars = {
      resourceTitle: loan.resource.title,
      dueDate: formatDate(loan.dueAt),
      daysOverdue: String(Math.abs(d)),
    };
    if (d < 0) {
      const template = await prisma.emailTemplate.findUnique({ where: { code: "OVERDUE" } });
      const key = `OVERDUE:${loan.memberId}:${template ? renderKey(template.subject, vars, loan.member.name) : ""}`;
      if (!alreadySent.has(key)) {
        await notify("OVERDUE", loan.member, vars);
        counts.overdue++;
      }
    } else if (d <= PREDUE_DAYS) {
      const template = await prisma.emailTemplate.findUnique({ where: { code: "PREDUE" } });
      const key = `PREDUE:${loan.memberId}:${template ? renderKey(template.subject, vars, loan.member.name) : ""}`;
      if (!alreadySent.has(key)) {
        await notify("PREDUE", loan.member, vars);
        counts.predue++;
      }
    }
  }

  // 2. Cancel READY reservations past their pickup window; promote next in queue.
  const readyHolds = await prisma.reservation.findMany({
    where: { status: "READY" },
    include: { member: true, resource: { include: { copies: true } } },
  });
  for (const hold of readyHolds) {
    const policy = await policyFor(hold.member.memberType);
    const expiry = new Date((hold.readyAt ?? hold.reservedAt).getTime() + policy.holdPickupDays * DAY);
    if (expiry > now) continue;

    await prisma.reservation.update({
      where: { id: hold.id },
      data: { status: "EXPIRED" },
    });
    await notify("RESERVATION_CANCELLED", hold.member, {
      resourceTitle: hold.resource.title,
    });
    counts.cancelled++;

    // Digital hold expired: offer the seat to the next in line.
    if (hold.resource.copies.length === 0) {
      const next = await prisma.reservation.findFirst({
        where: { resourceId: hold.resourceId, status: "PENDING" },
        orderBy: { reservedAt: "asc" },
        include: { member: true },
      });
      if (next) {
        await prisma.reservation.update({
          where: { id: next.id },
          data: { status: "READY", readyAt: now },
        });
        await notify("DIGITAL_AVAILABLE", next.member, {
          resourceTitle: hold.resource.title,
        });
      }
      continue;
    }

    // Pass the held copy to the next in line, or shelve it.
    const heldCopy = hold.resource.copies.find((c) => c.status === "RESERVED");
    if (heldCopy) {
      const next = await prisma.reservation.findFirst({
        where: { resourceId: hold.resourceId, status: "PENDING" },
        orderBy: { reservedAt: "asc" },
        include: { member: true },
      });
      if (next) {
        const nextPolicy = await policyFor(next.member.memberType);
        await prisma.reservation.update({
          where: { id: next.id },
          data: { status: "READY", readyAt: now },
        });
        await notify("RESERVATION_READY", next.member, {
          resourceTitle: hold.resource.title,
          expiryDate: formatDate(new Date(now.getTime() + nextPolicy.holdPickupDays * DAY)),
        });
      } else {
        await prisma.copy.update({
          where: { id: heldCopy.id },
          data: { status: "AVAILABLE" },
        });
      }
    }
  }

  // 3. Welcome new members (joined in the last day).
  const newMembers = await prisma.member.findMany({
    where: { joinedAt: { gte: since }, status: "ACTIVE" },
  });
  for (const m of newMembers) {
    if (alreadySent.has(`WELCOME:${m.id}:`) || recent.some((n) => n.type === "WELCOME" && n.memberId === m.id)) continue;
    await notify("WELCOME", m, {});
    counts.welcome++;
  }

  // 4. Inactive members: no loan activity for N months.
  const cutoff = new Date(Date.now() - INACTIVE_MONTHS * 30 * DAY);
  const members = await prisma.member.findMany({
    where: { status: "ACTIVE" },
    include: { loans: { orderBy: { borrowedAt: "desc" }, take: 1 } },
  });
  for (const m of members) {
    const last = m.loans[0]?.borrowedAt ?? m.joinedAt;
    if (last > cutoff) continue;
    if (recent.some((n) => n.type === "INACTIVE" && n.memberId === m.id)) continue;
    await notify("INACTIVE", m, {
      monthsInactive: String(Math.floor((Date.now() - last.getTime()) / (30 * DAY))),
    });
    counts.inactive++;
  }

  const summary = `Predue: ${counts.predue} · Overdue: ${counts.overdue} · Holds expired: ${counts.cancelled} · Welcome: ${counts.welcome} · Inactive: ${counts.inactive}`;
  await prisma.batchRun.create({
    data: { process: "EOD", summary, ranBy: admin?.name ?? "system" },
  });

  await audit({ action: "batch.eod", summary: `Ran EodProcess — ${summary}`, entity: "BatchRun" });
  revalidatePath("/admin", "layout");
  return { ok: true, message: `EodProcess complete — ${summary}` };
}

// Dedup key mirrors how notify() renders the subject line.
function renderKey(subjectTemplate: string, vars: Record<string, string>, memberName: string): string {
  return subjectTemplate.replace(/\{\{(\w+)\}\}/g, (m, k) =>
    k === "memberName" ? memberName : vars[k] ?? m,
  );
}

const LINK_TIMEOUT_MS = 5000;

/**
 * Broken-link scan (contract FR 8.2): checks every resource access URL and
 * records the result per resource, so administrators see failures on the
 * Batch Processes page.
 */
export async function runLinkCheck(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "BATCH"))
    return { ok: false, message: "You don't have permission to run batch processes." };

  const resources = await prisma.resource.findMany({
    where: { digitalUrl: { not: null } },
    select: { id: true, title: true, digitalUrl: true },
  });

  let broken = 0;
  // Small concurrency to keep the total under serverless time limits.
  const CHUNK = 6;
  for (let i = 0; i < resources.length; i += CHUNK) {
    await Promise.all(
      resources.slice(i, i + CHUNK).map(async (r) => {
        const result = await checkUrl(r.digitalUrl!);
        if (!result.ok) broken++;
        await prisma.linkCheck.upsert({
          where: { resourceId: r.id },
          update: { url: r.digitalUrl!, ...result, checkedAt: new Date() },
          create: { resourceId: r.id, url: r.digitalUrl!, ...result },
        });
      }),
    );
  }

  const summary = `Checked ${resources.length} link${resources.length === 1 ? "" : "s"} · ${broken} broken`;
  await prisma.batchRun.create({
    data: { process: "LINKCHECK", summary, ranBy: admin?.name ?? "system" },
  });

  await audit({ action: "batch.linkcheck", summary: `Ran link check — ${summary}`, entity: "BatchRun" });
  revalidatePath("/admin/batch");
  return { ok: true, message: `Link check complete — ${summary}.` };
}

/**
 * Manually trigger the scheduled SFTP metadata re-fetch (SDD: Metadata Import
 * Service). The same job runs unattended via Vercel Cron; this lets an admin
 * pull now. Reports imported / duplicate / skipped, or that the source is not
 * yet configured.
 */
export async function triggerSftpFetch(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "BATCH"))
    return { ok: false, message: "You don't have permission to run batch processes." };

  const summary = await runSftpFetch("manual");
  await audit({ action: "batch.sftpFetch", summary: `Triggered SFTP fetch — ${summary.message.slice(0, 200)}`, entity: "BatchRun" });
  return { ok: summary.status !== "error", message: summary.message };
}

async function checkUrl(url: string): Promise<{ ok: boolean; statusCode: number | null; error: string | null }> {
  if (isBlockedHost(url))
    return { ok: false, statusCode: null, error: "Blocked host (private/loopback)" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);
  try {
    // GET, not HEAD — several providers (incl. IEEE) reject HEAD requests.
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "AthenaeumLinkCheck/1.0" },
    });
    // Auth walls (401/403) mean the link resolves but needs the subscription —
    // that's not "broken" for an externally licensed resource.
    const ok = res.status < 500 && res.status !== 404 && res.status !== 410;
    return { ok, statusCode: res.status, error: ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "AbortError" ? "Timed out" : e.message) : "Fetch failed";
    return { ok: false, statusCode: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
