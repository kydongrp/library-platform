"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { isDigital } from "@/lib/availability";
import { policyFor } from "@/lib/policies";
import { notify } from "@/lib/templates";
import { formatDate } from "@/lib/format";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";

const DAY = 24 * 60 * 60 * 1000;

function revalidateAll() {
  revalidatePath("/admin", "layout");
}

/**
 * Check out a resource to a member.
 * Accepts a resourceId (picks an available copy) or an explicit copy barcode.
 * Digital resources are loaned without a physical copy.
 */
export async function checkout(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const memberId = String(formData.get("memberId") ?? "");
  const resourceId = String(formData.get("resourceId") ?? "");
  const barcode = String(formData.get("barcode") ?? "").trim();

  if (!memberId) return { ok: false, message: "Select a member." };

  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) return { ok: false, message: "Member not found." };
  if (member.status !== "ACTIVE")
    return { ok: false, message: `${member.name}'s account is suspended.` };

  const policy = await policyFor(member.memberType);
  // Member-specific override wins when set higher/lower than the policy.
  const maxLoans = member.maxLoans || policy.maxLoans;

  const activeLoans = await prisma.loan.count({
    where: { memberId, status: "ACTIVE" },
  });
  if (activeLoans >= maxLoans)
    return {
      ok: false,
      message: `Loan limit reached (${maxLoans} active loans).`,
    };

  // Resolve the resource either from a barcode or a resourceId.
  let copy = null;
  let resolvedResourceId = resourceId;

  if (barcode) {
    copy = await prisma.copy.findUnique({
      where: { barcode },
      include: { resource: true },
    });
    if (!copy) return { ok: false, message: `No copy with barcode ${barcode}.` };
    if (copy.status !== "AVAILABLE")
      return { ok: false, message: `Copy ${barcode} is ${copy.status.toLowerCase()}.` };
    resolvedResourceId = copy.resourceId;
  }

  if (!resolvedResourceId)
    return { ok: false, message: "Select a resource or scan a barcode." };

  const resource = await prisma.resource.findUnique({
    where: { id: resolvedResourceId },
    include: { copies: true },
  });
  if (!resource) return { ok: false, message: "Resource not found." };

  // Digital loan — no copy required.
  if (isDigital(resource)) {
    const existing = await prisma.loan.findFirst({
      where: { memberId, resourceId: resource.id, status: "ACTIVE" },
    });
    if (existing)
      return { ok: false, message: "Already on loan to this member." };

    // Concurrent access management: respect the licence seat cap.
    if (resource.licenseSeats != null) {
      const seatsInUse = await prisma.loan.count({
        where: { resourceId: resource.id, status: "ACTIVE" },
      });
      if (seatsInUse >= resource.licenseSeats)
        return {
          ok: false,
          message: `All ${resource.licenseSeats} licence seat${resource.licenseSeats === 1 ? " is" : "s are"} in use — place a hold to be notified.`,
        };
    }

    const dueAt = new Date(Date.now() + policy.digitalDays * DAY);
    await prisma.loan.create({
      data: { memberId, resourceId: resource.id, dueAt },
    });
    // Borrowing consumes any ready hold this member had on the title.
    await prisma.reservation.updateMany({
      where: { memberId, resourceId: resource.id, status: { in: ["READY", "PENDING"] } },
      data: { status: "FULFILLED" },
    });
    await notify("BORROW", member, {
      resourceTitle: resource.title,
      dueDate: formatDate(dueAt),
    });
    revalidateAll();
    return { ok: true, message: `"${resource.title}" loaned (digital access).` };
  }

  // Physical loan — find an available copy if one wasn't scanned.
  if (!copy) {
    copy = await prisma.copy.findFirst({
      where: { resourceId: resource.id, status: "AVAILABLE" },
      include: { resource: true },
    });
  }
  if (!copy) return { ok: false, message: "No copies available to loan." };

  const dueAt = new Date(Date.now() + policy.loanDays * DAY);

  await prisma.$transaction([
    prisma.loan.create({
      data: { memberId, resourceId: resource.id, copyId: copy.id, dueAt },
    }),
    prisma.copy.update({ where: { id: copy.id }, data: { status: "ON_LOAN" } }),
  ]);
  await notify("BORROW", member, {
    resourceTitle: resource.title,
    dueDate: formatDate(dueAt),
  });

  revalidateAll();
  return {
    ok: true,
    message: `"${resource.title}" checked out to ${member.name} — due ${dueAt.toLocaleDateString("en-GB")}.`,
  };
}

/** Return a loan, by loanId or by copy barcode. Promotes the next hold if any. */
export async function checkin(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const loanId = String(formData.get("loanId") ?? "");
  const barcode = String(formData.get("barcode") ?? "").trim();

  let loan = null;
  if (loanId) {
    loan = await prisma.loan.findUnique({
      where: { id: loanId },
      include: { copy: true, resource: true, member: true },
    });
  } else if (barcode) {
    const copy = await prisma.copy.findUnique({ where: { barcode } });
    if (!copy) return { ok: false, message: `No copy with barcode ${barcode}.` };
    loan = await prisma.loan.findFirst({
      where: { copyId: copy.id, status: "ACTIVE" },
      include: { copy: true, resource: true, member: true },
    });
  }

  if (!loan) return { ok: false, message: "No active loan found." };
  if (loan.status !== "ACTIVE")
    return { ok: false, message: "This loan was already returned." };

  await prisma.loan.update({
    where: { id: loan.id },
    data: { status: "RETURNED", returnedAt: new Date() },
  });
  await notify("RETURN", loan.member, { resourceTitle: loan.resource.title });

  let message = `"${loan.resource.title}" returned.`;

  // Digital return: a licence seat freed up — notify the next in queue.
  if (!loan.copyId) {
    const nextHold = await prisma.reservation.findFirst({
      where: { resourceId: loan.resourceId, status: "PENDING" },
      orderBy: { reservedAt: "asc" },
      include: { member: true },
    });
    if (nextHold) {
      await prisma.reservation.update({
        where: { id: nextHold.id },
        data: { status: "READY", readyAt: new Date() },
      });
      await notify("DIGITAL_AVAILABLE", nextHold.member, {
        resourceTitle: loan.resource.title,
      });
      message += ` Seat offered to ${nextHold.member.name} (next in queue).`;
    }
  }

  if (loan.copyId) {
    // If someone is waiting, hold the copy for them; otherwise shelve it.
    const nextHold = await prisma.reservation.findFirst({
      where: { resourceId: loan.resourceId, status: "PENDING" },
      orderBy: { reservedAt: "asc" },
      include: { member: true },
    });
    if (nextHold) {
      await prisma.$transaction([
        prisma.copy.update({ where: { id: loan.copyId }, data: { status: "RESERVED" } }),
        prisma.reservation.update({
          where: { id: nextHold.id },
          data: { status: "READY", readyAt: new Date() },
        }),
      ]);
      const holdPolicy = await policyFor(nextHold.member.memberType);
      await notify("RESERVATION_READY", nextHold.member, {
        resourceTitle: loan.resource.title,
        expiryDate: formatDate(new Date(Date.now() + holdPolicy.holdPickupDays * DAY)),
      });
      message += ` Held for ${nextHold.member.name} (next in queue).`;
    } else {
      await prisma.copy.update({
        where: { id: loan.copyId },
        data: { status: "AVAILABLE" },
      });
    }
  }

  revalidateAll();
  return { ok: true, message };
}

/** Extend a loan's due date if renewals remain and nobody is waiting. */
export async function renewLoan(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const loanId = String(formData.get("loanId") ?? "");
  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: { resource: true, member: true },
  });
  if (!loan || loan.status !== "ACTIVE")
    return { ok: false, message: "Loan not found." };

  const policy = await policyFor(loan.member.memberType);
  if (loan.renewals >= policy.maxRenewals)
    return { ok: false, message: "Renewal limit reached." };

  const waiting = await prisma.reservation.count({
    where: { resourceId: loan.resourceId, status: "PENDING" },
  });
  if (waiting > 0)
    return { ok: false, message: "Cannot renew — another member has reserved this title." };

  const dueAt = new Date(loan.dueAt.getTime() + policy.renewalDays * DAY);
  await prisma.loan.update({
    where: { id: loan.id },
    data: { dueAt, renewals: loan.renewals + 1 },
  });
  revalidateAll();
  return {
    ok: true,
    message: `Renewed — now due ${dueAt.toLocaleDateString("en-GB")}.`,
  };
}

/** Place a hold on a resource that currently has no available copy. */
export async function reserve(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const memberId = String(formData.get("memberId") ?? "");
  const resourceId = String(formData.get("resourceId") ?? "");
  if (!memberId) return { ok: false, message: "Sign in to reserve." };

  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    include: { copies: true },
  });
  if (!resource) return { ok: false, message: "Resource not found." };

  if (isDigital(resource)) {
    // Digital holds only make sense for seat-limited titles with all seats taken.
    if (resource.licenseSeats == null)
      return { ok: false, message: "This digital title has unlimited access — borrow it directly." };
    const seatsInUse = await prisma.loan.count({
      where: { resourceId, status: "ACTIVE" },
    });
    if (seatsInUse < resource.licenseSeats)
      return { ok: false, message: "A licence seat is free — borrow it instead." };
  } else {
    const available = resource.copies.some((c) => c.status === "AVAILABLE");
    if (available)
      return { ok: false, message: "Copies are available — borrow it instead." };
  }

  const existing = await prisma.reservation.findFirst({
    where: {
      memberId,
      resourceId,
      status: { in: ["PENDING", "READY"] },
    },
  });
  if (existing) return { ok: false, message: "You already have a hold on this title." };

  const ahead = await prisma.reservation.count({
    where: { resourceId, status: "PENDING" },
  });
  await prisma.reservation.create({ data: { memberId, resourceId } });
  revalidateAll();
  return {
    ok: true,
    message: ahead === 0 ? "Hold placed — you're first in line." : `Hold placed — ${ahead} ahead of you.`,
  };
}

/** Cancel a pending/ready hold. Frees the copy if it was held ready. */
export async function cancelReservation(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const reservationId = String(formData.get("reservationId") ?? "");
  const res = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { resource: { include: { copies: true } } },
  });
  if (!res) return { ok: false, message: "Reservation not found." };

  await prisma.reservation.update({
    where: { id: res.id },
    data: { status: "CANCELLED" },
  });

  // If it was held ready, release the reserved copy (or pass to next in line).
  if (res.status === "READY") {
    const heldCopy = res.resource.copies.find((c) => c.status === "RESERVED");
    if (heldCopy) {
      const nextHold = await prisma.reservation.findFirst({
        where: { resourceId: res.resourceId, status: "PENDING" },
        orderBy: { reservedAt: "asc" },
      });
      if (nextHold) {
        await prisma.reservation.update({
          where: { id: nextHold.id },
          data: { status: "READY", readyAt: new Date() },
        });
      } else {
        await prisma.copy.update({
          where: { id: heldCopy.id },
          data: { status: "AVAILABLE" },
        });
      }
    }
  }

  revalidateAll();
  return { ok: true, message: "Reservation cancelled." };
}

const RECALL_NOTICE_DAYS = 2;

/**
 * Staff recall of an active loan (contract FR 8.2): shortens the due date to
 * a short notice period and notifies the member. Requires LOANS edit rights.
 */
export async function recallLoan(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "LOANS"))
    return { ok: false, message: "You don't have permission to recall loans." };

  const loanId = String(formData.get("loanId") ?? "");
  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: { resource: true, member: true },
  });
  if (!loan || loan.status !== "ACTIVE")
    return { ok: false, message: "Loan not found." };
  if (loan.recalledAt)
    return { ok: false, message: "This loan has already been recalled." };

  const noticeDue = new Date(Date.now() + RECALL_NOTICE_DAYS * DAY);
  // Never extend: keep the earlier of the current due date and the notice.
  const dueAt = loan.dueAt < noticeDue ? loan.dueAt : noticeDue;

  await prisma.loan.update({
    where: { id: loan.id },
    data: { dueAt, recalledAt: new Date() },
  });
  await notify("RECALL", loan.member, {
    resourceTitle: loan.resource.title,
    newDueDate: formatDate(dueAt),
  });

  revalidateAll();
  return {
    ok: true,
    message: `"${loan.resource.title}" recalled — ${loan.member.name} notified, due ${formatDate(dueAt)}.`,
  };
}
