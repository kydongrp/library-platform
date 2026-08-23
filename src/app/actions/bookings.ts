"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit } from "@/lib/audit";
import {
  LIVE_BOOKING_STATUSES,
  validateWindow,
  WINDOW_PROBLEM_MESSAGE,
  findClash,
  isCollectable,
  describeWindow,
} from "@/lib/booking-core";

/**
 * Bookings (SDD rows 52-53): one specific copy held for a member over a
 * definite window. Distinct from a reservation, which queues for a title
 * that is currently out.
 */

async function requireBookings(): Promise<{ name: string } | null> {
  const admin = await getCurrentAdmin();
  if (!admin) return null;
  // Surfaced from the desk and from Reservations, so either grants it.
  return canEdit(admin, "CIRCULATION") || canEdit(admin, "RESERVATIONS")
    ? { name: admin.name }
    : null;
}

const NO_PERMISSION = {
  ok: false as const,
  message: "You don't have permission to manage bookings.",
};

const clip = (v: FormDataEntryValue | null, n: number) => String(v ?? "").trim().slice(0, n);

function revalidateBookings() {
  revalidatePath("/admin/reservations");
  revalidatePath("/admin/circulation");
  revalidatePath("/admin/loans");
}

/** Live bookings for a copy, optionally excluding one id (when editing). */
async function liveBookings(copyId: string, exceptId?: string) {
  return prisma.booking.findMany({
    where: {
      copyId,
      status: { in: [...LIVE_BOOKING_STATUSES] },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    include: { member: { select: { name: true } } },
    orderBy: { startAt: "asc" },
  });
}

export async function createBooking(_p: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireBookings();
  if (!admin) return NO_PERMISSION;

  const barcode = clip(formData.get("barcode"), 64).toUpperCase();
  const email = clip(formData.get("email"), 200).toLowerCase();
  const startRaw = clip(formData.get("startAt"), 40);
  const endRaw = clip(formData.get("endAt"), 40);
  const note = clip(formData.get("note"), 500) || null;

  if (!barcode) return { ok: false, message: "Scan or type the item barcode." };
  if (!email) return { ok: false, message: "Enter the member's email address." };
  if (!startRaw || !endRaw) return { ok: false, message: "Set both a start and an end time." };

  const startAt = new Date(startRaw);
  const endAt = new Date(endRaw);
  const problem = validateWindow({ startAt, endAt });
  if (problem) return { ok: false, message: WINDOW_PROBLEM_MESSAGE[problem] };

  const [copy, member] = await Promise.all([
    prisma.copy.findFirst({
      where: { barcode: { equals: barcode, mode: "insensitive" } },
      include: { resource: { select: { title: true } }, itemType: true },
    }),
    prisma.member.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, name: true, status: true },
    }),
  ]);
  if (!copy) return { ok: false, message: `No item with barcode ${barcode}.` };
  if (!member)
    return { ok: false, message: `No member has the email ${email}.` };
  // A reference-only item is never handed over, so it cannot be booked.
  if (copy.itemType && !copy.itemType.loanable)
    return {
      ok: false,
      message: `${copy.barcode} is "${copy.itemType.name}" — a reference-only item cannot be booked.`,
    };
  if (copy.status === "LOST")
    return { ok: false, message: `${copy.barcode} is marked lost.` };

  // Overlap check and insert under a lock on the copy row. A plain
  // read-then-write lets two staff both see a free window and both book it.
  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Copy" WHERE id = ${copy.id} FOR UPDATE`;
      const existing = await tx.booking.findMany({
        where: { copyId: copy.id, status: { in: [...LIVE_BOOKING_STATUSES] } },
        include: { member: { select: { name: true } } },
      });
      const clash = findClash({ startAt, endAt }, existing);
      if (clash) {
        throw Object.assign(new Error("CLASH"), {
          clashWith: `${clash.member.name} (${describeWindow(clash)})`,
        });
      }
      return tx.booking.create({
        data: {
          copyId: copy.id,
          memberId: member.id,
          startAt,
          endAt,
          note,
          createdBy: admin.name,
          status: "REQUESTED",
        },
      });
    });
  } catch (e) {
    const clashWith = (e as { clashWith?: string }).clashWith;
    if (clashWith)
      return {
        ok: false,
        message: `${copy.barcode} is already booked in that window by ${clashWith}.`,
      };
    throw e;
  }

  await audit({
    action: "bookings.create",
    summary: `Booked ${copy.barcode} ("${copy.resource.title}") for ${member.name}: ${describeWindow({ startAt, endAt })}`,
    entity: "Booking",
    entityId: created.id,
    detail: { copyId: copy.id, memberId: member.id, startAt, endAt },
  });
  revalidateBookings();
  return {
    ok: true,
    message: `Booking requested for ${member.name}: ${copy.barcode}, ${describeWindow({ startAt, endAt })}.`,
  };
}

export async function confirmBooking(_p: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireBookings();
  if (!admin) return NO_PERMISSION;
  const id = clip(formData.get("bookingId"), 40);

  const b = await prisma.booking.findUnique({
    where: { id },
    include: { copy: { include: { resource: { select: { title: true } } } }, member: true },
  });
  if (!b) return { ok: false, message: "Booking not found." };
  if (b.status !== "REQUESTED")
    return { ok: false, message: `That booking is already ${b.status.toLowerCase()}.` };

  // Re-check the clash at approval: another booking may have been confirmed
  // for the same window since this one was requested.
  const others = await liveBookings(b.copyId, b.id);
  const clash = findClash(b, others);
  if (clash)
    return {
      ok: false,
      message: `Cannot confirm — ${b.copy.barcode} is now booked in that window by ${clash.member.name}.`,
    };

  const res = await prisma.booking.updateMany({
    where: { id, status: "REQUESTED" },
    data: { status: "CONFIRMED", decidedBy: admin.name, decidedAt: new Date() },
  });
  if (res.count === 0) return { ok: false, message: "Someone just decided this booking." };

  await audit({
    action: "bookings.confirm",
    summary: `Confirmed the booking of ${b.copy.barcode} ("${b.copy.resource.title}") for ${b.member.name}: ${describeWindow(b)}`,
    entity: "Booking",
    entityId: id,
  });
  revalidateBookings();
  return { ok: true, message: `Confirmed for ${b.member.name}.` };
}

export async function cancelBooking(_p: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireBookings();
  if (!admin) return NO_PERMISSION;
  const id = clip(formData.get("bookingId"), 40);

  const b = await prisma.booking.findUnique({
    where: { id },
    include: { copy: true, member: true },
  });
  if (!b) return { ok: false, message: "Booking not found." };
  if (b.status === "COLLECTED")
    return { ok: false, message: "That booking was collected — check the loan in instead." };
  if (b.status === "CANCELLED") return { ok: false, message: "Already cancelled." };

  await prisma.booking.update({
    where: { id },
    data: { status: "CANCELLED", decidedBy: admin.name, decidedAt: new Date() },
  });
  await audit({
    action: "bookings.cancel",
    summary: `Cancelled ${b.member.name}'s booking of ${b.copy.barcode} (${describeWindow(b)}) — the window is free again`,
    entity: "Booking",
    entityId: id,
  });
  revalidateBookings();
  return { ok: true, message: "Booking cancelled; that window is free again." };
}

/**
 * Hand the item over: the booking becomes a loan. Reuses the ordinary loan
 * path rather than inventing a parallel one, so due dates, hourly item types
 * and fines all behave exactly as they do at the desk.
 */
export async function collectBooking(_p: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireBookings();
  if (!admin) return NO_PERMISSION;
  const id = clip(formData.get("bookingId"), 40);

  const b = await prisma.booking.findUnique({
    where: { id },
    include: {
      copy: { include: { resource: { select: { id: true, title: true } }, itemType: true } },
      member: true,
    },
  });
  if (!b) return { ok: false, message: "Booking not found." };
  if (b.status === "COLLECTED") return { ok: false, message: "Already collected." };
  if (!isCollectable(b))
    return {
      ok: false,
      message:
        b.status !== "CONFIRMED"
          ? "Confirm the booking before handing the item over."
          : `Outside the booked window (${describeWindow(b)}).`,
    };
  if (b.copy.status !== "AVAILABLE")
    return {
      ok: false,
      message: `${b.copy.barcode} is ${b.copy.status.toLowerCase().replace(/_/g, " ")} — it is not on the shelf to hand over.`,
    };

  // Due at the end of the booked window: the member booked it until then, and
  // an hourly item type is exactly this case.
  const dueAt = b.endAt;

  let loanId = "";
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.booking.updateMany({
        where: { id, status: "CONFIRMED" },
        data: { status: "COLLECTED", decidedBy: admin.name, decidedAt: new Date() },
      });
      if (claimed.count === 0) throw Object.assign(new Error("RACE"), { race: true });
      const loan = await tx.loan.create({
        data: {
          memberId: b.memberId,
          resourceId: b.copy.resource.id,
          copyId: b.copyId,
          dueAt,
        },
      });
      await tx.copy.update({ where: { id: b.copyId }, data: { status: "ON_LOAN" } });
      await tx.booking.update({ where: { id }, data: { loanId: loan.id } });
      loanId = loan.id;
    });
  } catch (e) {
    if ((e as { race?: boolean }).race)
      return { ok: false, message: "Someone just collected this booking." };
    throw e;
  }

  await audit({
    action: "bookings.collect",
    summary: `${b.member.name} collected ${b.copy.barcode} ("${b.copy.resource.title}") against a booking — due ${describeWindow({ startAt: b.startAt, endAt: dueAt }).split("–").pop()?.trim() ?? ""}`,
    entity: "Booking",
    entityId: id,
    detail: { loanId, dueAt },
  });
  revalidateBookings();
  return {
    ok: true,
    message: `Handed to ${b.member.name} — due back ${dueAt.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}.`,
  };
}

/** Mark a booking nobody came for, freeing the record without pretending it was collected. */
export async function markNoShow(_p: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireBookings();
  if (!admin) return NO_PERMISSION;
  const id = clip(formData.get("bookingId"), 40);

  const b = await prisma.booking.findUnique({
    where: { id },
    include: { copy: true, member: true },
  });
  if (!b) return { ok: false, message: "Booking not found." };
  if (b.status === "COLLECTED") return { ok: false, message: "That booking was collected." };
  if (b.endAt.getTime() > Date.now())
    return { ok: false, message: "That window has not closed yet." };

  await prisma.booking.updateMany({
    where: { id, status: { in: [...LIVE_BOOKING_STATUSES] } },
    data: { status: "NO_SHOW", decidedBy: admin.name, decidedAt: new Date() },
  });
  await audit({
    action: "bookings.noShow",
    summary: `${b.member.name} did not collect ${b.copy.barcode} within the booked window (${describeWindow(b)})`,
    entity: "Booking",
    entityId: id,
  });
  revalidateBookings();
  return { ok: true, message: "Recorded as not collected." };
}
