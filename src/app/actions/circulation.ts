"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { isDigital } from "@/lib/availability";
import { policyFor } from "@/lib/policies";
import { notify } from "@/lib/templates";
import { formatDate } from "@/lib/format";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit } from "@/lib/audit";
import { loadCalendar, dueDateFrom, nextOpenDay, dateKey } from "@/lib/calendar";
import { assessFine, formatFine } from "@/lib/fines";

const DAY = 24 * 60 * 60 * 1000;

// What staff can record about an item's condition when it comes back.
const RETURN_CONDITIONS = ["GOOD", "DAMAGED", "LOST"] as const;
type ReturnCondition = (typeof RETURN_CONDITIONS)[number];

/** Copy status an item lands in for a given return condition. */
const CONDITION_COPY_STATUS: Record<ReturnCondition, string> = {
  GOOD: "AVAILABLE",
  DAMAGED: "MAINTENANCE",
  LOST: "LOST",
};

function revalidateAll() {
  revalidatePath("/admin", "layout");
}

/**
 * Server actions are directly invocable endpoints, so every circulation
 * mutation re-checks rights here. These operations are surfaced from several
 * pages (the desk, Current Loans, member detail), so any one of the listed
 * areas grants them.
 */
async function requireCirculation(
  ...areas: string[]
): Promise<{ name: string } | null> {
  const admin = await getCurrentAdmin();
  if (!admin) return null;
  return areas.some((a) => canEdit(admin, a)) ? { name: admin.name } : null;
}

const DENIED = (what: string) => ({
  ok: false as const,
  message: `You don't have permission to ${what}.`,
});

/**
 * Check out a resource to a member.
 * Accepts a resourceId (picks an available copy) or an explicit copy barcode.
 * Digital resources are loaned without a physical copy.
 */
export async function checkout(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await requireCirculation("CIRCULATION"))) return DENIED("check items out");

  const memberId = String(formData.get("memberId") ?? "");
  const resourceId = String(formData.get("resourceId") ?? "");
  const barcode = String(formData.get("barcode") ?? "").trim();

  if (!memberId) return { ok: false, message: "Select a member." };

  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) return { ok: false, message: "Member not found." };
  // Custom statuses carry their own borrowing rule; a legacy status with no
  // row only borrows if it reads as active.
  const statusRow = await prisma.memberStatus.findUnique({ where: { name: member.status } });
  const canBorrow = statusRow?.canBorrow ?? /^active$/i.test(member.status);
  if (!canBorrow)
    return { ok: false, message: `${member.name}'s account status "${member.status}" does not allow borrowing.` };

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

    // Due dates never land on a day the library is shut.
    const dueAt = dueDateFrom(new Date(), policy.digitalDays, await loadCalendar());
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
    await audit({ action: "circulation.checkout", summary: `Digital loan: "${resource.title}" to ${member.name}`, entity: "Resource", entityId: resource.id, detail: { memberId, dueAt } });
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

  // Reference-only item types are never issued.
  const itemType = copy.itemTypeId
    ? await prisma.itemType.findUnique({ where: { id: copy.itemTypeId } })
    : null;
  if (itemType && !itemType.loanable)
    return {
      ok: false,
      message: `${copy.barcode} is catalogued as "${itemType.name}" — that item type cannot be loaned.`,
    };

  // Physical items resolve the policy on the member-type x item-type matrix.
  const itemPolicy = copy.itemTypeId
    ? await policyFor(member.memberType, copy.itemTypeId)
    : policy;
  // Row 56 (Hourly Loans): an hourly item type is due N hours from now. The
  // day-based calendar walk deliberately does not apply — a 4-hour equipment
  // loan is due this afternoon, not at the end of the next open day.
  const dueAt = itemType?.loanHours
    ? new Date(Date.now() + itemType.loanHours * 3_600_000)
    : dueDateFrom(new Date(), itemPolicy.loanDays, await loadCalendar());

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

  await audit({ action: "circulation.checkout", summary: `Checked out "${resource.title}" (${copy.barcode}) to ${member.name}`, entity: "Resource", entityId: resource.id, detail: { memberId, copyId: copy.id, dueAt } });
  revalidateAll();
  return {
    ok: true,
    message: `"${resource.title}" checked out to ${member.name} — due ${formatDate(dueAt)}.`,
  };
}

/** Return a loan, by loanId or by copy barcode. Promotes the next hold if any. */
export async function checkin(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCirculation("CIRCULATION", "LOANS");
  if (!admin) return DENIED("check items in");

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

  const conditionRaw = String(formData.get("condition") ?? "GOOD").toUpperCase();
  const condition: ReturnCondition = (RETURN_CONDITIONS as readonly string[]).includes(conditionRaw)
    ? (conditionRaw as ReturnCondition)
    : "GOOD";

  // Assess the fine against the calendar: lateness is measured in days the
  // library was actually open, so a closed weekend is never chargeable.
  const returnedAt = new Date();
  const [policy, cal] = await Promise.all([
    policyFor(loan.member.memberType),
    loadCalendar(),
  ]);
  // Row 51: if the member claimed this back weeks ago and it has only now
  // surfaced on the shelf, the fine is assessed as of the claim, not today.
  // Charging the search time would make the freeze meaningless.
  const fineAsOf = loan.claimedReturnedAt ?? returnedAt;
  const fine = assessFine(loan.dueAt, fineAsOf, policy, cal);
  // Lateness is judged on calendar DAYS, matching the fine counter. dueAt
  // carries the checkout time-of-day, so comparing instants would stamp an
  // item returned the morning it is due as LATE.
  // Judged as of the same moment the fine is, so an item claimed back on time
  // and later found mis-shelved is not recorded as a late return.
  const returnStatus = dateKey(fineAsOf) > dateKey(loan.dueAt) ? "LATE" : "ON_TIME";

  // Atomic close: a second scan of the same barcode must not re-return it.
  const claimed = await prisma.loan.updateMany({
    where: { id: loan.id, status: "ACTIVE" },
    data: {
      status: "RETURNED",
      returnedAt,
      returnStatus,
      returnCondition: condition,
      returnedBy: admin.name,
      // The claim is settled by the item turning up; clear it so the loan
      // does not linger on the claims worklist.
      claimedReturnedAt: null,
      claimedReturnNote: null,
      claimedReturnBy: null,
      fineCents: fine.cents,
      fineNote:
        fine.cents > 0
          ? `${fine.chargeableDays} chargeable day${fine.chargeableDays === 1 ? "" : "s"} of ${fine.daysLate} open day${fine.daysLate === 1 ? "" : "s"} late${fine.capped ? " (capped)" : ""}`
          : null,
    },
  });
  if (claimed.count === 0)
    return { ok: false, message: "That loan was just returned by someone else." };

  await notify("RETURN", loan.member, { resourceTitle: loan.resource.title });

  let message = `"${loan.resource.title}" returned.`;
  if (returnStatus === "LATE") {
    if (fine.cents > 0) {
      message += ` Late — fine ${formatFine(fine.cents)}${fine.capped ? " (capped)" : ""}.`;
    } else {
      // Say which of the three reasons actually applies, rather than blaming
      // closures for a zero-rate policy or an unspent grace period.
      const why =
        policy.fineCentsPerDay <= 0
          ? "this member type is not fined"
          : fine.daysLate === 0
            ? "the library was closed every day it was late"
            : `within the ${policy.fineGraceDays}-day grace period`;
      message += ` Late, but no fine — ${why}.`;
    }
  }
  if (condition !== "GOOD")
    message += ` Marked ${condition.toLowerCase()}.`;

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
    // A damaged or lost copy leaves circulation — it must never be handed to
    // the next person waiting.
    if (condition !== "GOOD") {
      await prisma.copy.update({
        where: { id: loan.copyId },
        data: { status: CONDITION_COPY_STATUS[condition] },
      });
      message +=
        condition === "LOST"
          ? " Copy withdrawn as lost."
          : " Copy sent to maintenance.";
    } else {
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
        // The pickup deadline must fall on a day the library is open.
        const expiry = nextOpenDay(new Date(Date.now() + holdPolicy.holdPickupDays * DAY), cal);
        await notify("RESERVATION_READY", nextHold.member, {
          resourceTitle: loan.resource.title,
          expiryDate: formatDate(expiry),
        });
        message += ` Held for ${nextHold.member.name} (next in queue).`;
      } else {
        await prisma.copy.update({
          where: { id: loan.copyId },
          data: { status: "AVAILABLE" },
        });
      }
    }
  }

  await audit({
    action: "circulation.checkin",
    summary: `Returned "${loan.resource.title}" from ${loan.member.name} — ${returnStatus === "LATE" ? `late${fine.cents > 0 ? `, fine ${formatFine(fine.cents)}` : ", no fine chargeable"}` : "on time"}, condition ${condition.toLowerCase()}`,
    entity: "Loan",
    entityId: loan.id,
    detail: { returnStatus, condition, fineCents: fine.cents, daysLate: fine.daysLate, chargeableDays: fine.chargeableDays },
  });
  revalidateAll();
  return { ok: true, message };
}

/** Extend a loan's due date if renewals remain and nobody is waiting. */
export async function renewLoan(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await requireCirculation("CIRCULATION", "LOANS"))) return DENIED("renew loans");

  const loanId = String(formData.get("loanId") ?? "");
  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: { resource: true, member: true, copy: { include: { itemType: true } } },
  });
  if (!loan || loan.status !== "ACTIVE")
    return { ok: false, message: "Loan not found." };

  // Row 51: a loan the member says they returned is under investigation, not
  // in their hands. Renewing it would assert they still hold it.
  if (loan.claimedReturnedAt)
    return {
      ok: false,
      message: "Cannot renew — this loan is marked as a claimed return. Resolve the claim first.",
    };

  const policy = await policyFor(loan.member.memberType);
  if (loan.renewals >= policy.maxRenewals)
    return { ok: false, message: "Renewal limit reached." };

  const waiting = await prisma.reservation.count({
    where: { resourceId: loan.resourceId, status: "PENDING" },
  });
  if (waiting > 0)
    return { ok: false, message: "Cannot renew — another member has reserved this title." };

  // Row 56: for an hourly loan "overdue" is a moment, not a day — a 2pm item
  // is late at 4pm even though the calendar day has not turned.
  const hours = loan.copy?.itemType?.loanHours ?? null;
  const overdue = hours
    ? loan.dueAt.getTime() < Date.now()
    : dateKey(loan.dueAt) < dateKey(new Date());

  // An overdue loan cannot be renewed: rebasing off a past due date would
  // retroactively erase the fine that has already accrued, and may not even
  // clear the overdue state. Staff check it in (freezing the fine) instead.
  if (overdue)
    return {
      ok: false,
      message: "Cannot renew — this loan is overdue. Check it in to settle the fine, then check it out again.",
    };

  // Renewal extends from the existing due date (unused time is not lost).
  // An hourly loan extends by its own hours; extending it by renewalDays
  // would turn a 4-hour equipment loan into a fortnight.
  const dueAt = hours
    ? new Date(loan.dueAt.getTime() + hours * 3_600_000)
    : dueDateFrom(loan.dueAt, policy.renewalDays, await loadCalendar());
  await prisma.loan.update({
    where: { id: loan.id },
    data: { dueAt, renewals: loan.renewals + 1 },
  });
  await audit({ action: "circulation.renew", summary: `Renewed "${loan.resource.title}" for ${loan.member.name} (renewal ${loan.renewals + 1})`, entity: "Loan", entityId: loan.id, detail: { dueAt } });
  revalidateAll();
  return {
    ok: true,
    message: `Renewed — now due ${formatDate(dueAt)}.`,
  };
}

/** Place a hold on a resource that currently has no available copy. */
export async function reserve(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await requireCirculation("CIRCULATION", "RESERVATIONS")))
    return DENIED("place holds");

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
  const hold = await prisma.reservation.create({ data: { memberId, resourceId } });
  await audit({ action: "circulation.reserve", summary: `Hold placed on "${resource.title}"`, entity: "Reservation", entityId: hold.id, detail: { memberId, resourceId } });
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
  if (!(await requireCirculation("CIRCULATION", "RESERVATIONS")))
    return DENIED("cancel holds");

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

  await audit({ action: "circulation.cancelHold", summary: `Cancelled hold on "${res.resource.title}"`, entity: "Reservation", entityId: res.id });
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

  // The recall deadline must fall on a day the member can actually return it.
  const noticeDue = nextOpenDay(
    new Date(Date.now() + RECALL_NOTICE_DAYS * DAY),
    await loadCalendar(),
  );
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

  await audit({ action: "circulation.recall", summary: `Recalled "${loan.resource.title}" from ${loan.member.name} — due ${formatDate(dueAt)}`, entity: "Loan", entityId: loan.id });
  revalidateAll();
  return {
    ok: true,
    message: `"${loan.resource.title}" recalled — ${loan.member.name} notified, due ${formatDate(dueAt)}.`,
  };
}

/* ---------- Fine settlement ---------- */

/** Mark an assessed fine as paid at the desk. */
export async function payFine(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "LOANS"))
    return { ok: false, message: "You don't have permission to settle fines." };

  const loanId = String(formData.get("loanId") ?? "");
  const r = await prisma.loan.updateMany({
    where: { id: loanId, fineCents: { gt: 0 }, finePaidAt: null, fineWaivedAt: null },
    data: { finePaidAt: new Date() },
  });
  if (r.count === 0)
    return { ok: false, message: "That fine is already settled or no longer exists." };

  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: { member: true, resource: true },
  });
  await audit({
    action: "circulation.finePaid",
    summary: `Fine ${formatFine(loan?.fineCents ?? 0)} paid by ${loan?.member.name ?? "?"} for "${loan?.resource.title ?? "?"}"`,
    entity: "Loan",
    entityId: loanId,
  });
  revalidateAll();
  return { ok: true, message: `Fine of ${formatFine(loan?.fineCents ?? 0)} marked paid.` };
}

/** Waive an assessed fine, with the reason recorded on the loan. */
export async function waiveFine(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "LOANS"))
    return { ok: false, message: "You don't have permission to waive fines." };

  const loanId = String(formData.get("loanId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 200);
  const r = await prisma.loan.updateMany({
    where: { id: loanId, fineCents: { gt: 0 }, finePaidAt: null, fineWaivedAt: null },
    data: {
      fineWaivedAt: new Date(),
      fineNote: reason ? `Waived by ${admin?.name ?? "staff"}: ${reason}` : `Waived by ${admin?.name ?? "staff"}`,
    },
  });
  if (r.count === 0)
    return { ok: false, message: "That fine is already settled or no longer exists." };

  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: { member: true, resource: true },
  });
  await audit({
    action: "circulation.fineWaived",
    summary: `Fine ${formatFine(loan?.fineCents ?? 0)} waived for ${loan?.member.name ?? "?"} on "${loan?.resource.title ?? "?"}"${reason ? ` — ${reason}` : ""}`,
    entity: "Loan",
    entityId: loanId,
  });
  revalidateAll();
  return { ok: true, message: "Fine waived." };
}
