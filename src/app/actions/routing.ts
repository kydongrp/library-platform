"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/templates";
import { canRouteIn, canRouteOut, planRun } from "@/lib/routing-core";

// Routing is serials work: same CATALOGUE edit gate as the rest of the module.
async function requireRoutingEditor(): Promise<{ name: string } | null> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "CATALOGUE")) return null;
  return { name: admin!.name };
}

const NO_PERMISSION = {
  ok: false as const,
  message: "You don't have permission to manage serial routing.",
};

const clip = (v: FormDataEntryValue | null, n: number) => String(v ?? "").trim().slice(0, n);
const isUnique = (e: unknown) =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

const ROUTING_LIST_MAX = 100;

/** Both surfaces that show routing state: the list page and the routing page. */
function revalidateRouting(serialId: string): void {
  revalidatePath("/admin/serials");
  revalidatePath(`/admin/serials/${serialId}/routing`);
}

/* ---------- Routing list management (rows 69, 71) ---------- */

export async function addRoutingSubscriber(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireRoutingEditor();
  if (!admin) return NO_PERMISSION;

  const serialId = clip(formData.get("serialId"), 40);
  const alertOnly = formData.get("alertOnly") === "on";
  const email = clip(formData.get("email"), 200).toLowerCase();
  if (!email) return { ok: false, message: "Enter the member's email address." };

  const [serial, member] = await Promise.all([
    prisma.serial.findUnique({
      where: { id: serialId },
      select: { id: true, resource: { select: { title: true } } },
    }),
    prisma.member.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, name: true },
    }),
  ]);
  if (!serial) return { ok: false, message: "Serial not found." };
  if (!member)
    return { ok: false, message: `No member has the email ${email}. Check the address or add them under Members.` };

  const count = await prisma.routingSubscriber.count({ where: { serialId } });
  if (count >= ROUTING_LIST_MAX)
    return { ok: false, message: `A routing list holds at most ${ROUTING_LIST_MAX} people.` };

  // Append at the end of the order. Adds to one list are serialised on the
  // parent Serial row: under READ COMMITTED a plain read-then-write (and even
  // an INSERT ... SELECT MAX(seq)) lets concurrent adds compute the same seq,
  // which was measured producing seqs [1,2,2,3,3,3] for six simultaneous adds.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Serial" WHERE id = ${serialId} FOR UPDATE`;
      const last = await tx.routingSubscriber.findFirst({
        where: { serialId },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      await tx.routingSubscriber.create({
        data: { serialId, memberId: member.id, seq: (last?.seq ?? 0) + 1, alertOnly },
      });
    });
  } catch (e) {
    if (isUnique(e))
      return { ok: false, message: `${member.name} is already on this routing list.` };
    throw e;
  }
  await audit({
    action: "serials.routing.add",
    summary: `Added ${member.name} to the ${alertOnly ? "alert list" : "routing list"} for "${serial.resource.title}"`,
    // The subject of the change is the serial's list, so record the serial.
    entity: "Serial",
    entityId: serial.id,
  });
  revalidateRouting(serial.id);
  return {
    ok: true,
    message: alertOnly
      ? `${member.name} will be alerted when an issue arrives.`
      : `${member.name} added to the routing list.`,
  };
}

export async function removeRoutingSubscriber(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireRoutingEditor();
  if (!admin) return NO_PERMISSION;
  const id = clip(formData.get("id"), 40);
  const row = await prisma.routingSubscriber.findUnique({
    where: { id },
    include: { member: { select: { name: true } }, serial: { include: { resource: { select: { title: true } } } } },
  });
  if (!row) return { ok: false, message: "Already removed." };
  await prisma.routingSubscriber.delete({ where: { id } });
  await audit({
    action: "serials.routing.remove",
    summary: `Removed ${row.member.name} from the routing list for "${row.serial.resource.title}"`,
    entity: "Serial",
    entityId: row.serialId,
  });
  revalidateRouting(row.serialId);
  return {
    ok: true,
    message: `${row.member.name} removed. Runs already in progress keep their own list.`,
  };
}

/** Move a subscriber up or down the order by swapping seq with its neighbour. */
export async function moveRoutingSubscriber(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireRoutingEditor();
  if (!admin) return NO_PERMISSION;
  const id = clip(formData.get("id"), 40);
  const dir = clip(formData.get("dir"), 4) === "up" ? "up" : "down";

  const row = await prisma.routingSubscriber.findUnique({ where: { id } });
  if (!row) return { ok: false, message: "That entry no longer exists." };

  // Swap within the same population. The displayed routing order excludes
  // alert-only rows, so swapping a routed member with an alert-only
  // neighbour would renumber the data while the visible order never moved.
  const neighbour = await prisma.routingSubscriber.findFirst({
    where: {
      serialId: row.serialId,
      alertOnly: row.alertOnly,
      seq: dir === "up" ? { lt: row.seq } : { gt: row.seq },
    },
    orderBy: { seq: dir === "up" ? "desc" : "asc" },
  });
  if (!neighbour)
    return { ok: false, message: dir === "up" ? "Already first." : "Already last." };

  // Swap in one transaction so a half-applied reorder cannot survive.
  await prisma.$transaction([
    prisma.routingSubscriber.update({ where: { id: row.id }, data: { seq: neighbour.seq } }),
    prisma.routingSubscriber.update({ where: { id: neighbour.id }, data: { seq: row.seq } }),
  ]);
  revalidateRouting(row.serialId);
  return { ok: true, message: `Moved ${dir}.` };
}

export async function toggleAlertOnly(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireRoutingEditor();
  if (!admin) return NO_PERMISSION;
  const id = clip(formData.get("id"), 40);
  const row = await prisma.routingSubscriber.findUnique({
    where: { id },
    include: { member: { select: { name: true } } },
  });
  if (!row) return { ok: false, message: "That entry no longer exists." };
  await prisma.routingSubscriber.update({
    where: { id },
    data: { alertOnly: !row.alertOnly },
  });
  revalidateRouting(row.serialId);
  return {
    ok: true,
    message: row.alertOnly
      ? `${row.member.name} now receives the issue in the routing order.`
      : `${row.member.name} is now alert-only.`,
  };
}

/* ---------- Routing runs (row 70) ---------- */

/**
 * Start routing a received issue: snapshots the serial's routing order into
 * stops so later list edits cannot corrupt a run in progress.
 */
export async function startRouting(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireRoutingEditor();
  if (!admin) return NO_PERMISSION;
  const issueId = clip(formData.get("issueId"), 40);

  const issue = await prisma.serialIssue.findUnique({
    where: { id: issueId },
    include: {
      serial: {
        include: {
          resource: { select: { title: true } },
          routing: { orderBy: [{ seq: "asc" }, { id: "asc" }] },
        },
      },
      routingStops: { select: { id: true } },
    },
  });
  if (!issue) return { ok: false, message: "Issue not found." };
  if (issue.status !== "RECEIVED")
    return { ok: false, message: "Only a received issue can be routed. Check it in first." };
  if (issue.routingStops.length > 0)
    return { ok: false, message: "This issue already has a routing run." };

  const plan = planRun(issue.serial.routing);
  if (plan.length === 0)
    return {
      ok: false,
      message: "No one on the routing list receives the issue. Add someone who is not alert-only.",
    };

  try {
    await prisma.issueRoutingStop.createMany({
      data: plan.map((p) => ({ issueId, memberId: p.memberId, seq: p.runSeq })),
    });
  } catch (e) {
    // Two staff starting at once: the unique (issueId, memberId) rejects the
    // loser rather than duplicating the run.
    if (isUnique(e))
      return { ok: false, message: "Someone just started routing this issue. Reload to see it." };
    throw e;
  }
  await audit({
    action: "serials.routing.start",
    summary: `Started routing ${issue.label} of "${issue.serial.resource.title}" through ${plan.length} ${plan.length === 1 ? "person" : "people"}`,
    entity: "SerialIssue",
    entityId: issueId,
  });
  revalidateRouting(issue.serialId);
  return { ok: true, message: `Routing started: ${plan.length} stops. Route it out to the first person.` };
}

export async function routeOut(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireRoutingEditor();
  if (!admin) return NO_PERMISSION;
  const issueId = clip(formData.get("issueId"), 40);

  const stops = await prisma.issueRoutingStop.findMany({
    where: { issueId },
    include: { member: { select: { id: true, name: true, email: true } } },
    orderBy: [{ seq: "asc" }, { id: "asc" }],
  });
  const verdict = canRouteOut(stops);
  if (!verdict.ok) return { ok: false, message: verdict.why };

  const target = stops.find((s) => s.seq === verdict.to.seq)!;
  // Atomic claim: only an unrouted stop can be routed out, so two staff
  // clicking together cannot hand the same issue to two people.
  const claim = await prisma.issueRoutingStop.updateMany({
    where: { id: target.id, routedOut: null },
    data: { routedOut: new Date(), routedBy: admin.name },
  });
  if (claim.count === 0)
    return { ok: false, message: "Someone just routed this issue out. Reload to see where it is." };

  const issue = await prisma.serialIssue.findUnique({
    where: { id: issueId },
    include: { serial: { include: { resource: { select: { title: true } } } } },
  });
  await audit({
    action: "serials.routing.out",
    summary: `Routed ${issue?.label ?? "issue"} of "${issue?.serial.resource.title ?? "?"}" out to ${target.member.name} (stop ${target.seq})`,
    entity: "IssueRoutingStop",
    entityId: target.id,
  });
  if (issue) revalidateRouting(issue.serialId);
  return { ok: true, message: `Routed out to ${target.member.name} (stop ${target.seq} of ${stops.length}).` };
}

export async function routeIn(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireRoutingEditor();
  if (!admin) return NO_PERMISSION;
  const issueId = clip(formData.get("issueId"), 40);

  const stops = await prisma.issueRoutingStop.findMany({
    where: { issueId },
    include: { member: { select: { name: true } } },
    orderBy: [{ seq: "asc" }, { id: "asc" }],
  });
  const verdict = canRouteIn(stops);
  if (!verdict.ok) return { ok: false, message: verdict.why };

  const current = stops.find((s) => s.seq === verdict.from.seq)!;
  const claim = await prisma.issueRoutingStop.updateMany({
    where: { id: current.id, routedIn: null },
    data: { routedIn: new Date() },
  });
  if (claim.count === 0)
    return { ok: false, message: "That stop was just closed by someone else." };

  const remaining = stops.filter((s) => !s.routedOut).length;
  const issue = await prisma.serialIssue.findUnique({
    where: { id: issueId },
    include: { serial: { include: { resource: { select: { title: true } } } } },
  });
  await audit({
    action: "serials.routing.in",
    summary: `Routed ${issue?.label ?? "issue"} of "${issue?.serial.resource.title ?? "?"}" back in from ${current.member.name} (stop ${current.seq})`,
    entity: "IssueRoutingStop",
    entityId: current.id,
  });
  if (issue) revalidateRouting(issue.serialId);
  return {
    ok: true,
    message: remaining > 0
      ? `Back from ${current.member.name}. ${remaining} ${remaining === 1 ? "stop" : "stops"} left.`
      : `Back from ${current.member.name}. The routing run is complete.`,
  };
}

/**
 * Journal alerts (row 71): notify everyone on the list that the issue has
 * arrived. Alert-only subscribers exist for exactly this, and routing
 * recipients are told too so they know it is coming.
 */
export async function sendIssueAlerts(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireRoutingEditor();
  if (!admin) return NO_PERMISSION;
  const issueId = clip(formData.get("issueId"), 40);

  const issue = await prisma.serialIssue.findUnique({
    where: { id: issueId },
    include: {
      serial: {
        include: {
          resource: { select: { title: true } },
          routing: { include: { member: { select: { id: true, name: true, email: true } } } },
        },
      },
    },
  });
  if (!issue) return { ok: false, message: "Issue not found." };
  if (issue.status !== "RECEIVED")
    return { ok: false, message: "Alerts go out once the issue has been checked in." };
  if (issue.serial.routing.length === 0)
    return { ok: false, message: "No one is on this serial's list yet." };

  // notify() is fire-and-forget: it silently does nothing when the template
  // row is missing or both channels are switched off. Counting loop turns
  // would report alerts that were never sent, so measure the writes instead.
  const template = await prisma.emailTemplate.findUnique({
    where: { code: "SERIAL_ISSUE" },
    select: { inAppEnabled: true, emailEnabled: true },
  });
  if (!template)
    return {
      ok: false,
      message: "The 'New serial issue arrived' template is missing, so nothing would be sent.",
    };
  if (!template.inAppEnabled && !template.emailEnabled)
    return {
      ok: false,
      message: "Both channels are switched off for that template. Enable one under Email Templates.",
    };

  const before = await prisma.notification.count({ where: { type: "SERIAL_ISSUE" } });
  const mailBefore = await prisma.mailQueue.count({ where: { template: "SERIAL_ISSUE" } });
  // notify() is two writes per person and runs in the request, so a full
  // 100-name list would be 200 sequential round trips. Send in bounded
  // parallel batches to keep one click well inside the function timeout.
  const BATCH = 10;
  const recipients = issue.serial.routing;
  for (let i = 0; i < recipients.length; i += BATCH) {
    await Promise.all(
      recipients.slice(i, i + BATCH).map((sub) =>
        notify("SERIAL_ISSUE", sub.member, {
          resourceTitle: issue.serial.resource.title,
          issueLabel: issue.label,
        }),
      ),
    );
  }
  const inApp = (await prisma.notification.count({ where: { type: "SERIAL_ISSUE" } })) - before;
  const mailed = (await prisma.mailQueue.count({ where: { template: "SERIAL_ISSUE" } })) - mailBefore;
  const sent = Math.max(inApp, mailed);
  // Record the send so the page can show the list was already told; a second
  // click then reads as a deliberate re-send rather than an accident.
  await prisma.serialIssue.update({ where: { id: issueId }, data: { alertsSentAt: new Date() } });
  await audit({
    action: "serials.routing.alert",
    summary: `Sent ${sent} arrival ${sent === 1 ? "alert" : "alerts"} for ${issue.label} of "${issue.serial.resource.title}"`,
    entity: "SerialIssue",
    entityId: issueId,
  });
  revalidateRouting(issue.serialId);
  return { ok: true, message: `Alerted ${sent} ${sent === 1 ? "person" : "people"} that ${issue.label} has arrived.` };
}

/**
 * Abandon a routing run (row 70, the exit path). Real circulation stalls:
 * the recipient goes on leave, or the copy is lost mid-round. Clearing the
 * stops returns the issue to "not routed" so a fresh run can start, and the
 * audit trail records what was discarded.
 */
export async function cancelRouting(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireRoutingEditor();
  if (!admin) return NO_PERMISSION;
  const issueId = clip(formData.get("issueId"), 40);

  const issue = await prisma.serialIssue.findUnique({
    where: { id: issueId },
    include: {
      serial: { include: { resource: { select: { title: true } } } },
      routingStops: { include: { member: { select: { name: true } } }, orderBy: { seq: "asc" } },
    },
  });
  if (!issue) return { ok: false, message: "Issue not found." };
  if (issue.routingStops.length === 0)
    return { ok: false, message: "This issue has no routing run." };

  const out = issue.routingStops.find((s) => s.routedOut && !s.routedIn);
  const done = issue.routingStops.filter((s) => s.routedIn).length;
  await prisma.issueRoutingStop.deleteMany({ where: { issueId } });

  await audit({
    action: "serials.routing.cancel",
    summary: `Cancelled the routing run for ${issue.label} of "${issue.serial.resource.title}" after ${done} of ${issue.routingStops.length} stops${out ? `; it was out with ${out.member.name}` : ""}`,
    entity: "SerialIssue",
    entityId: issueId,
    detail: {
      completed: done,
      total: issue.routingStops.length,
      outWith: out?.member.name ?? null,
    },
  });
  revalidateRouting(issue.serialId);
  return {
    ok: true,
    message: out
      ? `Run cancelled. It was still out with ${out.member.name} — chase the copy separately.`
      : "Run cancelled. You can start a fresh run for this issue.",
  };
}
