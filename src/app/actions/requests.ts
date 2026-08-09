"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentMember } from "@/lib/session";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { notify } from "@/lib/templates";

/** Learner submits an information resource request (contract FR 8.1). */
export async function submitRequest(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const member = await getCurrentMember();
  if (!member) return { ok: false, message: "Sign in to submit a request." };

  const title = String(formData.get("title") ?? "").trim();
  const author = String(formData.get("author") ?? "").trim() || null;
  const details = String(formData.get("details") ?? "").trim() || null;
  if (!title) return { ok: false, message: "Tell us the title you're after." };

  await prisma.resourceRequest.create({
    data: { title, author, details, memberId: member.id },
  });
  revalidatePath("/portal/requests");
  revalidatePath("/admin/requests");
  return { ok: true, message: "Request submitted — the library team will review it." };
}

/** Learner cancels their own pending request. */
export async function cancelRequest(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const member = await getCurrentMember();
  if (!member) return { ok: false, message: "Sign in first." };

  const id = String(formData.get("requestId") ?? "");
  const request = await prisma.resourceRequest.findUnique({ where: { id } });
  if (!request || request.memberId !== member.id)
    return { ok: false, message: "Request not found." };
  if (request.status !== "PENDING")
    return { ok: false, message: "Only pending requests can be withdrawn." };

  await prisma.resourceRequest.delete({ where: { id } });
  revalidatePath("/portal/requests");
  revalidatePath("/admin/requests");
  return { ok: true, message: "Request withdrawn." };
}

const REQUEST_STATUSES = new Set(["PENDING", "APPROVED", "REJECTED", "ACQUIRED"]);

/** Staff updates a request's status; the member is notified. */
export async function updateRequestStatus(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "REQUESTS"))
    return { ok: false, message: "You don't have permission to manage requests." };

  const id = String(formData.get("requestId") ?? "");
  const status = String(formData.get("status") ?? "");
  const staffNote = String(formData.get("staffNote") ?? "").trim() || null;
  if (!REQUEST_STATUSES.has(status)) return { ok: false, message: "Invalid status." };

  const request = await prisma.resourceRequest.findUnique({
    where: { id },
    include: { member: true },
  });
  if (!request) return { ok: false, message: "Request not found." };

  await prisma.resourceRequest.update({
    where: { id },
    data: { status, staffNote, decidedBy: admin!.name },
  });

  if (status !== request.status && status !== "PENDING") {
    await notify("REQUEST_UPDATE", request.member, {
      requestTitle: request.title,
      requestStatus: status.toLowerCase(),
    });
  }

  revalidatePath("/admin/requests");
  revalidatePath("/portal/requests");
  return { ok: true, message: `Request marked ${status.toLowerCase()}.` };
}

/** Learner accepts the digital-resource terms & conditions (contract FR 8.1). */
export async function acceptTerms(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const member = await getCurrentMember();
  if (!member) return { ok: false, message: "Sign in first." };
  await prisma.member.update({
    where: { id: member.id },
    data: { tcAcceptedAt: new Date() },
  });
  revalidatePath("/portal", "layout");
  return { ok: true, message: "Terms accepted — you now have access to digital resources." };
}
