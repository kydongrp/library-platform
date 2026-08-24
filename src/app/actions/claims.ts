"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit } from "@/lib/audit";
import { formatFine } from "@/lib/fines";

/**
 * Claimed returns (SDD row 51): a member says they brought an item back, the
 * shelf says otherwise.
 *
 * The loan deliberately stays ACTIVE: nothing has actually come back, and
 * marking it returned would corrupt the holdings and hand the member a clean
 * record for an item still missing. What the claim does is stop the fine
 * clock while staff go and look, and put the loan on a worklist so the
 * question is not quietly forgotten.
 *
 * A claim resolves one of two ways: the item is FOUND (check it in normally)
 * or it is not (write it off as lost, which is the honest outcome).
 */

async function requireLoansEditor(): Promise<{ name: string } | null> {
  const admin = await getCurrentAdmin();
  // Same gate as the rest of circulation: either desk or loans rights.
  if (!canEdit(admin, "CIRCULATION") && !canEdit(admin, "LOANS")) return null;
  return { name: admin!.name };
}

const NO_PERMISSION = {
  ok: false as const,
  message: "You don't have permission to manage claimed returns.",
};

const clip = (v: FormDataEntryValue | null, n: number) => String(v ?? "").trim().slice(0, n);

function revalidateClaims() {
  revalidatePath("/admin/loans");
  revalidatePath("/admin/loans/claims");
  revalidatePath("/admin/circulation");
}

/** Record that the member says this item was returned. */
export async function claimReturned(_p: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireLoansEditor();
  if (!admin) return NO_PERMISSION;

  const loanId = clip(formData.get("loanId"), 40);
  const note = clip(formData.get("note"), 500) || null;

  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: { resource: true, member: true, copy: true },
  });
  if (!loan) return { ok: false, message: "Loan not found." };
  if (loan.status !== "ACTIVE")
    return { ok: false, message: "That loan is already closed." };
  if (loan.claimedReturnedAt)
    return { ok: false, message: "This loan is already marked as a claimed return." };

  // Atomic claim so two staff recording it at once cannot double-stamp.
  const res = await prisma.loan.updateMany({
    where: { id: loanId, status: "ACTIVE", claimedReturnedAt: null },
    data: { claimedReturnedAt: new Date(), claimedReturnNote: note, claimedReturnBy: admin.name },
  });
  if (res.count === 0)
    return { ok: false, message: "Someone just recorded this claim. Reload to see it." };

  await audit({
    action: "circulation.claimReturn",
    summary: `${loan.member.name} claims "${loan.resource.title}" was returned${loan.copy ? ` (${loan.copy.barcode})` : ""}; fines frozen pending a shelf check`,
    entity: "Loan",
    entityId: loanId,
    detail: { note, dueAt: loan.dueAt },
  });
  revalidateClaims();
  return {
    ok: true,
    message: `Claim recorded. Fines stop accruing while ${loan.copy?.barcode ?? "the item"} is searched for.`,
  };
}

/** Withdraw a claim: the member accepts they still have it. */
export async function withdrawClaim(_p: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireLoansEditor();
  if (!admin) return NO_PERMISSION;
  const loanId = clip(formData.get("loanId"), 40);

  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: { resource: true, member: true },
  });
  if (!loan) return { ok: false, message: "Loan not found." };
  if (!loan.claimedReturnedAt) return { ok: false, message: "That loan has no open claim." };

  await prisma.loan.update({
    where: { id: loanId },
    data: { claimedReturnedAt: null, claimedReturnNote: null, claimedReturnBy: null },
  });
  await audit({
    action: "circulation.claimWithdraw",
    summary: `Withdrew the claimed return on "${loan.resource.title}" for ${loan.member.name}; the loan is live again and fines resume`,
    entity: "Loan",
    entityId: loanId,
  });
  revalidateClaims();
  return {
    ok: true,
    message: "Claim withdrawn. The loan is active again and fines resume from its due date.",
  };
}

/**
 * The search failed: write the item off. The loan closes as LOST and the copy
 * is marked LOST so it stops appearing as shelf stock. Any fine already
 * accrued is left alone: the fine and the replacement are separate matters,
 * and silently zeroing one hides it from the ledger.
 */
export async function writeOffClaim(_p: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireLoansEditor();
  if (!admin) return NO_PERMISSION;
  const loanId = clip(formData.get("loanId"), 40);

  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: { resource: true, member: true, copy: true },
  });
  if (!loan) return { ok: false, message: "Loan not found." };
  if (!loan.claimedReturnedAt) return { ok: false, message: "That loan has no open claim." };
  if (loan.status !== "ACTIVE") return { ok: false, message: "That loan is already closed." };

  const now = new Date();
  await prisma.$transaction([
    prisma.loan.updateMany({
      where: { id: loanId, status: "ACTIVE" },
      data: {
        status: "RETURNED",
        returnedAt: now,
        // The item never came back: the outcome is LOST, not a return.
        returnStatus: "LATE",
        returnCondition: "LOST",
        returnedBy: admin.name,
      },
    }),
    ...(loan.copyId
      ? [prisma.copy.update({ where: { id: loan.copyId }, data: { status: "LOST" } })]
      : []),
  ]);

  await audit({
    action: "circulation.claimWriteOff",
    summary: `Wrote off "${loan.resource.title}"${loan.copy ? ` (${loan.copy.barcode})` : ""} as lost after ${loan.member.name}'s claimed return could not be verified${loan.fineCents > 0 ? `; ${formatFine(loan.fineCents)} fine left standing` : ""}`,
    entity: "Loan",
    entityId: loanId,
    detail: { fineCents: loan.fineCents, claimedAt: loan.claimedReturnedAt },
  });
  revalidateClaims();
  revalidatePath("/admin/items");
  return {
    ok: true,
    message: `Written off as lost.${loan.copy ? ` ${loan.copy.barcode} is now marked Lost.` : ""}`,
  };
}
