"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit } from "@/lib/audit";
import {
  FREQUENCIES,
  predictIssues,
  issueLabel,
  queueClaim,
  EXTEND_BY,
  MIN_UPCOMING,
  type Frequency,
} from "@/lib/serials";

// Serials control is catalogue work — every mutation re-checks CATALOGUE
// edit rights (server actions are directly invocable endpoints).
async function requireSerialsEditor(): Promise<{ name: string } | null> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "CATALOGUE")) return null;
  return { name: admin!.name };
}

const NO_PERMISSION = { ok: false as const, message: "You don't have permission to manage serials." };
const clip = (v: FormDataEntryValue | null, n: number) => String(v ?? "").trim().slice(0, n);
// Issue tracking is gated on the bib-level designation, not the format type.
const MAX_OPEN_ISSUES = 120; // schedule-length backstop per serial

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

/** Top the schedule up so at least MIN_UPCOMING future issues exist. */
async function topUpSchedule(serialId: string): Promise<number> {
  const serial = await prisma.serial.findUnique({
    where: { id: serialId },
    include: { issues: { orderBy: { seq: "desc" }, take: 1 } },
  });
  if (!serial || serial.status !== "ACTIVE" || serial.issues.length === 0) return 0;
  const open = await prisma.serialIssue.count({
    where: { serialId, status: "EXPECTED", expectedAt: { gte: new Date() } },
  });
  if (open >= MIN_UPCOMING) return 0;
  const total = await prisma.serialIssue.count({ where: { serialId } });
  if (total >= MAX_OPEN_ISSUES) return 0;
  const last = serial.issues[0];
  const add = predictIssues(serial.frequency as Frequency, last.seq, last.expectedAt, EXTEND_BY);
  await prisma.serialIssue.createMany({
    data: add.map((i) => ({ serialId, ...i })),
    skipDuplicates: true,
  });
  return add.length;
}

export async function registerSerial(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireSerialsEditor();
  if (!admin) return NO_PERMISSION;

  const resourceId = clip(formData.get("resourceId"), 40);
  if (!resourceId) return { ok: false, message: "Pick the catalogue title this serial belongs to." };
  const frequency = clip(formData.get("frequency"), 12) as Frequency;
  if (!(FREQUENCIES as readonly string[]).includes(frequency))
    return { ok: false, message: "Choose a publication frequency." };
  const firstRaw = clip(formData.get("firstExpected"), 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstRaw))
    return { ok: false, message: "Set the first expected issue date." };
  const firstExpected = new Date(`${firstRaw}T12:00:00Z`);
  if (Number.isNaN(firstExpected.getTime()))
    return { ok: false, message: "First expected date is not a valid date." };

  const issn = clip(formData.get("issn"), 20) || null;
  const claimEmail = clip(formData.get("claimEmail"), 200) || null;
  if (claimEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(claimEmail))
    return { ok: false, message: "Claim contact must be an email address." };

  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { title: true, materialDesignation: true },
  });
  if (!resource) return { ok: false, message: "That title no longer exists." };
  if (resource.materialDesignation !== "SERIAL")
    return {
      ok: false,
      message: `"${resource.title}" is catalogued as a monograph — change its material designation to Serial before tracking issues.`,
    };

  // First issue lands ON the chosen date; the rest follow the pattern.
  const first = { seq: 1, label: issueLabel(1, firstExpected), expectedAt: firstExpected };
  const rest = predictIssues(frequency, 1, firstExpected, 11);

  try {
    const serial = await prisma.serial.create({
      data: {
        resourceId,
        issn,
        frequency,
        claimEmail,
        notes: clip(formData.get("notes"), 1000) || null,
        issues: { create: [first, ...rest] },
      },
    });
    await audit({
      action: "serials.register",
      summary: `Registered serial "${resource.title}" (${frequency.toLowerCase()}, 12 issues predicted)`,
      entity: "Serial",
      entityId: serial.id,
    });
  } catch (e) {
    if (isUniqueViolation(e))
      return { ok: false, message: `"${resource.title}" is already tracked as a serial.` };
    throw e;
  }
  revalidatePath("/admin/serials");
  return { ok: true, message: `"${resource.title}" registered — 12 issues predicted from ${firstRaw}.` };
}

export async function updateSerial(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireSerialsEditor();
  if (!admin) return NO_PERMISSION;

  const id = clip(formData.get("id"), 40);
  const serial = await prisma.serial.findUnique({
    where: { id },
    include: { resource: { select: { title: true } } },
  });
  if (!serial) return { ok: false, message: "That serial no longer exists." };

  const frequency = clip(formData.get("frequency"), 12) as Frequency;
  if (!(FREQUENCIES as readonly string[]).includes(frequency))
    return { ok: false, message: "Choose a publication frequency." };
  const status = clip(formData.get("status"), 10);
  if (!["ACTIVE", "PAUSED", "CLOSED"].includes(status))
    return { ok: false, message: "Status must be Active, Paused, or Closed." };
  const claimEmail = clip(formData.get("claimEmail"), 200) || null;
  if (claimEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(claimEmail))
    return { ok: false, message: "Claim contact must be an email address." };

  const data = {
    issn: clip(formData.get("issn"), 20) || null,
    frequency,
    status,
    claimEmail,
    notes: clip(formData.get("notes"), 1000) || null,
  };
  await prisma.serial.update({ where: { id }, data });
  await audit({
    action: "serials.update",
    summary: `Updated serial "${serial.resource.title}" (${status.toLowerCase()}, ${frequency.toLowerCase()})`,
    entity: "Serial",
    entityId: id,
    detail: { before: { issn: serial.issn, frequency: serial.frequency, status: serial.status, claimEmail: serial.claimEmail }, after: data },
  });
  revalidatePath("/admin/serials");
  return { ok: true, message: "Serial updated. Frequency changes apply to future predictions." };
}

export async function deleteSerial(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireSerialsEditor();
  if (!admin) return NO_PERMISSION;

  const id = clip(formData.get("id"), 40);
  const serial = await prisma.serial.findUnique({
    where: { id },
    include: { resource: { select: { title: true } } },
  });
  if (!serial) return { ok: false, message: "That serial no longer exists." };
  await prisma.serial.delete({ where: { id } }); // issues cascade; catalogue record stays
  await audit({
    action: "serials.delete",
    summary: `Stopped tracking serial "${serial.resource.title}" (issue history removed, catalogue record kept)`,
    entity: "Serial",
    entityId: id,
  });
  revalidatePath("/admin/serials");
  return { ok: true, message: `"${serial.resource.title}" is no longer tracked as a serial.` };
}

/* ---------- Issue operations ---------- */

async function loadIssue(issueId: string) {
  return prisma.serialIssue.findUnique({
    where: { id: issueId },
    include: { serial: { include: { resource: { select: { title: true } } } } },
  });
}

export async function checkInIssue(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireSerialsEditor();
  if (!admin) return NO_PERMISSION;

  const issueId = clip(formData.get("issueId"), 40);
  // Atomic claim: only an EXPECTED issue can be received.
  const r = await prisma.serialIssue.updateMany({
    where: { id: issueId, status: "EXPECTED" },
    data: { status: "RECEIVED", receivedAt: new Date() },
  });
  if (r.count === 0) return { ok: false, message: "That issue is gone or already checked in." };

  const issue = await loadIssue(issueId);
  const added = issue ? await topUpSchedule(issue.serialId) : 0;
  await audit({
    action: "serials.checkin",
    summary: `Checked in ${issue?.label ?? "an issue"} of "${issue?.serial.resource.title ?? "?"}"${added ? ` (+${added} issues predicted)` : ""}`,
    entity: "SerialIssue",
    entityId: issueId,
  });
  revalidatePath("/admin/serials");
  return { ok: true, message: `${issue?.label ?? "Issue"} checked in.` };
}

export async function reopenIssue(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireSerialsEditor();
  if (!admin) return NO_PERMISSION;

  const issueId = clip(formData.get("issueId"), 40);
  const r = await prisma.serialIssue.updateMany({
    where: { id: issueId, status: { in: ["RECEIVED", "SKIPPED"] } },
    data: { status: "EXPECTED", receivedAt: null },
  });
  if (r.count === 0) return { ok: false, message: "That issue can't be reopened." };

  // Undoing the receipt voids any routing run for it: the copy was never
  // really in hand. Leaving the stops behind would both block a fresh run
  // (startRouting refuses when stops exist) and show a completed circulation
  // for an issue the library no longer claims to have received.
  const stops = await prisma.issueRoutingStop.deleteMany({ where: { issueId } });

  const issue = await loadIssue(issueId);
  await audit({
    action: "serials.reopen",
    summary: `Reopened ${issue?.label ?? "an issue"} of "${issue?.serial.resource.title ?? "?"}" (back to expected)${stops.count ? `; discarded a routing run of ${stops.count} stops` : ""}`,
    entity: "SerialIssue",
    entityId: issueId,
  });
  revalidatePath("/admin/serials");
  return {
    ok: true,
    message: stops.count
      ? `Issue reopened as expected. Its routing run (${stops.count} stops) was discarded.`
      : "Issue reopened as expected.",
  };
}

export async function skipIssue(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireSerialsEditor();
  if (!admin) return NO_PERMISSION;

  const issueId = clip(formData.get("issueId"), 40);
  const r = await prisma.serialIssue.updateMany({
    where: { id: issueId, status: "EXPECTED" },
    data: { status: "SKIPPED" },
  });
  if (r.count === 0) return { ok: false, message: "Only expected issues can be marked not published." };
  const issue = await loadIssue(issueId);
  await audit({
    action: "serials.skip",
    summary: `Marked ${issue?.label ?? "an issue"} of "${issue?.serial.resource.title ?? "?"}" as not published`,
    entity: "SerialIssue",
    entityId: issueId,
  });
  revalidatePath("/admin/serials");
  return { ok: true, message: "Marked as not published — it won't be claimed." };
}

export async function claimIssue(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireSerialsEditor();
  if (!admin) return NO_PERMISSION;

  const issueId = clip(formData.get("issueId"), 40);
  const issue = await loadIssue(issueId);
  if (!issue || issue.status !== "EXPECTED")
    return { ok: false, message: "Only expected (missing) issues can be claimed." };

  const queued = await queueClaim(issue.serial, issue.serial.resource.title, issue);
  await prisma.serialIssue.update({ where: { id: issueId }, data: { claimedAt: new Date() } });
  await audit({
    action: "serials.claim",
    summary: `Claimed ${issue.label} of "${issue.serial.resource.title}" (${queued} email${queued === 1 ? "" : "s"} queued)`,
    entity: "SerialIssue",
    entityId: issueId,
  });
  revalidatePath("/admin/serials");
  return {
    ok: true,
    message: issue.serial.claimEmail
      ? `Claim queued to ${issue.serial.claimEmail}.`
      : "No vendor contact set — administrators alerted instead.",
  };
}

export async function extendSchedule(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireSerialsEditor();
  if (!admin) return NO_PERMISSION;

  const serialId = clip(formData.get("serialId"), 40);
  const serial = await prisma.serial.findUnique({
    where: { id: serialId },
    include: {
      resource: { select: { title: true } },
      issues: { orderBy: { seq: "desc" }, take: 1 },
    },
  });
  if (!serial) return { ok: false, message: "That serial no longer exists." };
  if (serial.issues.length === 0) return { ok: false, message: "This serial has no schedule to extend." };
  const total = await prisma.serialIssue.count({ where: { serialId } });
  if (total >= MAX_OPEN_ISSUES)
    return { ok: false, message: "Schedule is at its maximum length — check issues in first." };

  const last = serial.issues[0];
  const add = predictIssues(serial.frequency as Frequency, last.seq, last.expectedAt, EXTEND_BY);
  await prisma.serialIssue.createMany({ data: add.map((i) => ({ serialId, ...i })), skipDuplicates: true });
  await audit({
    action: "serials.extend",
    summary: `Extended "${serial.resource.title}" schedule by ${add.length} issues (to ${add[add.length - 1].label})`,
    entity: "Serial",
    entityId: serialId,
  });
  revalidatePath("/admin/serials");
  return { ok: true, message: `Predicted ${add.length} more issues, up to ${add[add.length - 1].label}.` };
}
