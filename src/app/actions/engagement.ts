"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentMember } from "@/lib/session";

/* ---------- Reviews (one per member per resource) ---------- */

export async function saveReview(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const member = await getCurrentMember();
  if (!member) return { ok: false, message: "Sign in to review." };

  const resourceId = String(formData.get("resourceId") ?? "");
  const rating = parseInt(String(formData.get("rating") ?? ""), 10);
  const text = String(formData.get("text") ?? "").trim() || null;

  if (!resourceId) return { ok: false, message: "Missing resource." };
  if (!Number.isFinite(rating) || rating < 1 || rating > 5)
    return { ok: false, message: "Pick a star rating (1–5)." };

  const resource = await prisma.resource.findUnique({ where: { id: resourceId } });
  if (!resource) return { ok: false, message: "Resource not found." };

  await prisma.review.upsert({
    where: { resourceId_memberId: { resourceId, memberId: member.id } },
    update: { rating, text },
    create: { resourceId, memberId: member.id, rating, text },
  });

  revalidatePath(`/portal/resource/${resourceId}`);
  revalidatePath("/portal/my-reviews");
  revalidatePath("/portal");
  return { ok: true, message: "Review saved." };
}

export async function deleteReview(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const member = await getCurrentMember();
  if (!member) return { ok: false, message: "Sign in first." };

  const reviewId = String(formData.get("reviewId") ?? "");
  const review = await prisma.review.findUnique({ where: { id: reviewId } });
  if (!review || review.memberId !== member.id)
    return { ok: false, message: "Review not found." };

  await prisma.review.delete({ where: { id: reviewId } });
  revalidatePath(`/portal/resource/${review.resourceId}`);
  revalidatePath("/portal/my-reviews");
  revalidatePath("/portal");
  return { ok: true, message: "Review deleted." };
}

/* ---------- Notification Centre ---------- */

export async function markNotificationRead(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const member = await getCurrentMember();
  if (!member) return { ok: false, message: "Sign in first." };

  const id = String(formData.get("notificationId") ?? "");
  const all = formData.get("all") === "1";

  if (all) {
    await prisma.notification.updateMany({
      where: { memberId: member.id, readAt: null },
      data: { readAt: new Date() },
    });
  } else if (id) {
    await prisma.notification.updateMany({
      where: { id, memberId: member.id },
      data: { readAt: new Date() },
    });
  }
  revalidatePath("/portal", "layout");
  return { ok: true, message: all ? "All notifications marked read." : "Marked read." };
}
