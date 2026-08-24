// Serials management (SDD): server-side rollups and vendor claims. The pure
// vocabulary and prediction math live in serials-shared.ts (client-safe,
// no prisma) and are re-exported here for server code.

import { daysBetweenInstants, startOfZonedMonth, zonedDayKey } from "@/lib/tz";
import { prisma } from "@/lib/db";
import { GRACE_DAYS, isLate, type Frequency } from "@/lib/serials-shared";

export * from "@/lib/serials-shared";

const DAY_MS = 86_400_000;

/* ---------- Overview for the admin page ---------- */

export type SerialRow = {
  id: string;
  resourceId: string;
  title: string;
  provider: string | null;
  issn: string | null;
  frequency: Frequency;
  status: string;
  claimEmail: string | null;
  notes: string | null;
  received: number;
  holdings: string | null; // e.g. "No. 1 (Sep 2025) – No. 11 (Jul 2026)"
  nextIssue: { id: string; label: string; expectedAt: Date } | null;
  lateIssues: { id: string; label: string; expectedAt: Date; daysLate: number; claimedAt: Date | null }[];
};

export type SerialsOverview = {
  serials: SerialRow[];
  totalActive: number;
  dueThisMonth: number;
  lateTotal: number;
  claims30: number;
  recentCheckIns: { serial: string; label: string; receivedAt: Date }[];
};

export async function getSerialsOverview(now = new Date()): Promise<SerialsOverview> {
  const [serials, claims30] = await Promise.all([
    prisma.serial.findMany({
      include: {
        resource: { select: { title: true, provider: true } },
        issues: { orderBy: { seq: "asc" } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.mailQueue.count({
      where: { template: "SERIAL_CLAIM", createdAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } },
    }),
  ]);

  const monthStart = startOfZonedMonth(now);
  const monthEnd = startOfZonedMonth(now, 1);
  let dueThisMonth = 0;
  const recentCheckIns: SerialsOverview["recentCheckIns"] = [];

  const rows: SerialRow[] = serials.map((s) => {
    const receivedIssues = s.issues.filter((i) => i.status === "RECEIVED");
    const expected = s.issues.filter((i) => i.status === "EXPECTED");
    const late = expected
      .filter((i) => isLate(i, now))
      .map((i) => ({
        id: i.id,
        label: i.label,
        expectedAt: i.expectedAt,
        daysLate: daysBetweenInstants(i.expectedAt, now),
        claimedAt: i.claimedAt,
      }));
    const next = expected.filter((i) => !isLate(i, now))[0] ?? null;

    dueThisMonth += expected.filter((i) => i.expectedAt >= monthStart && i.expectedAt < monthEnd).length;
    for (const i of receivedIssues) {
      if (i.receivedAt) recentCheckIns.push({ serial: s.resource.title, label: i.label, receivedAt: i.receivedAt });
    }

    return {
      id: s.id,
      resourceId: s.resourceId,
      title: s.resource.title,
      provider: s.resource.provider,
      issn: s.issn,
      frequency: s.frequency as Frequency,
      status: s.status,
      claimEmail: s.claimEmail,
      notes: s.notes,
      received: receivedIssues.length,
      holdings:
        receivedIssues.length > 0
          ? receivedIssues.length === 1
            ? receivedIssues[0].label
            : `${receivedIssues[0].label} – ${receivedIssues[receivedIssues.length - 1].label}`
          : null,
      nextIssue: next ? { id: next.id, label: next.label, expectedAt: next.expectedAt } : null,
      lateIssues: late,
    };
  });

  recentCheckIns.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  return {
    serials: rows,
    totalActive: rows.filter((r) => r.status === "ACTIVE").length,
    dueThisMonth,
    lateTotal: rows.reduce((n, r) => n + r.lateIssues.length, 0),
    claims30,
    recentCheckIns: recentCheckIns.slice(0, 10),
  };
}

/* ---------- Claims (manual button + nightly cron sweep) ---------- */

export async function queueClaim(
  serial: { claimEmail: string | null; issn: string | null },
  title: string,
  issue: { label: string; expectedAt: Date },
  now = new Date(),
): Promise<number> {
  // Calendar days, not elapsed time. expectedAt is a date-only value stored
  // at noon UTC, i.e. 20:00 Singapore, so the old arithmetic told a vendor an
  // issue was N days late where N could be one lower than the true count.
  const daysLate = daysBetweenInstants(issue.expectedAt, now);
  const subject = `Missing issue claim: ${title} (${issue.label})`;
  const body = `We have not received ${issue.label} of "${title}"${serial.issn ? ` (ISSN ${serial.issn})` : ""}, expected ${zonedDayKey(issue.expectedAt)} (${daysLate} days ago).\n\nPlease supply the issue or advise on its status.\n\nKong Learning Systems Institute, Digital Library`;

  if (serial.claimEmail) {
    await prisma.mailQueue.create({
      data: { toEmail: serial.claimEmail, toName: "Serials vendor", subject, body, template: "SERIAL_CLAIM" },
    });
    return 1;
  }
  // No vendor contact on record: alert active admins instead.
  const admins = await prisma.adminUser.findMany({
    where: { status: "ACTIVE" },
    select: { name: true, email: true },
  });
  if (admins.length === 0) return 0;
  await prisma.mailQueue.createMany({
    data: admins.map((a) => ({
      toEmail: a.email,
      toName: a.name,
      subject,
      body: body + "\n\n(No vendor claim contact is set for this serial; add one on the Serials page.)",
      template: "SERIAL_CLAIM",
    })),
  });
  return admins.length;
}

export type ClaimSweepResult = { checked: number; late: number; claimsQueued: number };

/** Nightly sweep: claim every late, not-yet-claimed issue of ACTIVE serials. */
export async function runSerialClaims(now = new Date()): Promise<ClaimSweepResult> {
  const grace = new Date(now.getTime() - GRACE_DAYS * DAY_MS);
  const lateIssues = await prisma.serialIssue.findMany({
    where: {
      status: "EXPECTED",
      expectedAt: { lt: grace },
      serial: { status: "ACTIVE" },
    },
    include: { serial: { include: { resource: { select: { title: true } } } } },
  });

  let claimsQueued = 0;
  for (const issue of lateIssues) {
    if (issue.claimedAt) continue; // claimed already (manually or a prior sweep)
    claimsQueued += await queueClaim(
      issue.serial,
      issue.serial.resource.title,
      issue,
      now,
    );
    await prisma.serialIssue.update({ where: { id: issue.id }, data: { claimedAt: now } });
  }
  return { checked: lateIssues.length, late: lateIssues.length, claimsQueued };
}
