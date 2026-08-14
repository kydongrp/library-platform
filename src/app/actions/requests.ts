"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { notify } from "@/lib/templates";
import { audit } from "@/lib/audit";

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

  await audit({
    action: "requests.decide",
    summary: `Request "${request.title}" marked ${status.toLowerCase()}`,
    entity: "ResourceRequest",
    entityId: id,
    detail: { from: request.status, to: status, staffNote },
  });
  revalidatePath("/admin/requests");
  return { ok: true, message: `Request marked ${status.toLowerCase()}.` };
}
