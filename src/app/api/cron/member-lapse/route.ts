import { NextResponse } from "next/server";
import { denyUnlessCron } from "@/app/api/cron/_guard";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { decideLapse, lastActiveAt, type StatusRule } from "@/lib/member-status";

/**
 * Nightly membership lapse.
 *
 * A status may declare `autoAfterInactiveDays`, and this applies it to members
 * who have not borrowed or reserved anything in that long. It is the rule that
 * replaced the manual "can borrow" flag: an account lapses because nobody used
 * it, not because somebody remembered to tick a box.
 *
 * Deliberately conservative. It does nothing at all until a library sets a
 * period, it never touches a member who already holds a suspending status, and
 * it never lapses a member with an OPEN loan, who is demonstrably still holding
 * library property and would otherwise be blocked at the return desk.
 *
 * Each change is audited individually, because "your account was suspended" is
 * a question a member will ask at the counter and somebody has to be able to
 * answer it.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Never touch more than this in one night; a runaway rule should be visible. */
const MAX_PER_RUN = 500;

export async function GET(request: Request): Promise<NextResponse> {
  const denied = denyUnlessCron(request);
  if (denied) return denied;

  const now = new Date();

  const statuses = await prisma.memberStatus.findMany({
    select: { name: true, suspends: true, isDefault: true, autoAfterInactiveDays: true },
  });
  const rules: StatusRule[] = statuses;

  const active = rules.filter((r) => r.suspends && (r.autoAfterInactiveDays ?? 0) > 0);
  if (active.length === 0) {
    return NextResponse.json({
      ok: true,
      skipped: "No status is configured to apply automatically.",
      lapsed: 0,
    });
  }

  // Only members who are NOT already on a suspending status can lapse, so the
  // candidate set is bounded before any per-member work.
  const suspendingNames = rules.filter((r) => r.suspends).map((r) => r.name);
  const candidates = await prisma.member.findMany({
    where: { status: { notIn: suspendingNames } },
    select: {
      id: true,
      name: true,
      status: true,
      joinedAt: true,
      loans: { select: { borrowedAt: true, returnedAt: true } },
      reservations: { select: { reservedAt: true } },
    },
    take: 5_000,
  });

  const changed: { id: string; name: string; from: string; to: string; days: number }[] = [];

  for (const m of candidates) {
    if (changed.length >= MAX_PER_RUN) break;
    const decision = decideLapse(
      {
        status: m.status,
        openLoans: m.loans.filter((l) => l.returnedAt === null).length,
        lastActive: lastActiveAt(m),
      },
      rules,
      now,
    );
    if (!decision.lapse) continue;
    changed.push({
      id: m.id,
      name: m.name,
      from: m.status,
      to: decision.toStatus,
      days: decision.daysInactive,
    });
  }

  for (const c of changed) {
    // Guarded update: if a member's status changed since the scan, leave them
    // alone rather than overwriting a decision a human just made.
    const res = await prisma.member.updateMany({
      where: { id: c.id, status: c.from },
      data: { status: c.to },
    });
    if (res.count === 0) continue;
    await audit({
      action: "members.autoLapse",
      summary: `${c.name} moved to "${c.to}" after ${c.days} days without borrowing`,
      entity: "Member",
      entityId: c.id,
      detail: { from: c.from, to: c.to, daysInactive: c.days },
      actor: { name: "Membership lapse job" },
    });
  }

  return NextResponse.json({
    ok: true,
    considered: candidates.length,
    lapsed: changed.length,
    cappedAt: changed.length >= MAX_PER_RUN ? MAX_PER_RUN : undefined,
  });
}
