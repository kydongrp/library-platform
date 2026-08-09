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

/* ---------- Favourites (folders + bookmarks) ---------- */

export async function createFolder(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const member = await getCurrentMember();
  if (!member) return { ok: false, message: "Sign in first." };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, message: "Give the collection a name." };

  const existing = await prisma.favouriteFolder.findUnique({
    where: { memberId_name: { memberId: member.id, name } },
  });
  if (existing) return { ok: false, message: "You already have a collection with that name." };

  await prisma.favouriteFolder.create({ data: { memberId: member.id, name } });
  revalidatePath("/portal/favourites");
  return { ok: true, message: `Collection "${name}" created.` };
}

export async function deleteFolder(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const member = await getCurrentMember();
  if (!member) return { ok: false, message: "Sign in first." };

  const folderId = String(formData.get("folderId") ?? "");
  const folder = await prisma.favouriteFolder.findUnique({ where: { id: folderId } });
  if (!folder || folder.memberId !== member.id)
    return { ok: false, message: "Collection not found." };

  await prisma.favouriteFolder.delete({ where: { id: folderId } });
  revalidatePath("/portal/favourites");
  return { ok: true, message: `Collection "${folder.name}" deleted.` };
}

/** Add/remove a title in a folder. Creates the member's default folder on first use. */
export async function toggleBookmark(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const member = await getCurrentMember();
  if (!member) return { ok: false, message: "Sign in to save favourites." };

  const resourceId = String(formData.get("resourceId") ?? "");
  let folderId = String(formData.get("folderId") ?? "");

  if (!folderId) {
    // No folder specified: use (or create) the default "My Favourites".
    const def = await prisma.favouriteFolder.upsert({
      where: { memberId_name: { memberId: member.id, name: "My Favourites" } },
      update: {},
      create: { memberId: member.id, name: "My Favourites" },
    });
    folderId = def.id;
  } else {
    const folder = await prisma.favouriteFolder.findUnique({ where: { id: folderId } });
    if (!folder || folder.memberId !== member.id)
      return { ok: false, message: "Collection not found." };
  }

  const existing = await prisma.favouriteItem.findUnique({
    where: { folderId_resourceId: { folderId, resourceId } },
  });
  if (existing) {
    await prisma.favouriteItem.delete({ where: { id: existing.id } });
    revalidatePath(`/portal/resource/${resourceId}`);
    revalidatePath("/portal/favourites");
    return { ok: true, message: "Removed from collection." };
  }

  await prisma.favouriteItem.create({ data: { folderId, resourceId } });
  revalidatePath(`/portal/resource/${resourceId}`);
  revalidatePath("/portal/favourites");
  return { ok: true, message: "Added to collection." };
}

/* ---------- Areas of Interest ---------- */

export async function saveInterests(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const member = await getCurrentMember();
  if (!member) return { ok: false, message: "Sign in first." };

  const interests = formData.getAll("interests").map(String).filter(Boolean);
  await prisma.member.update({
    where: { id: member.id },
    data: { interests },
  });
  revalidatePath("/portal", "layout");
  return {
    ok: true,
    message: interests.length
      ? `Saved — recommendations now follow ${interests.length} area${interests.length === 1 ? "" : "s"} of interest.`
      : "Saved — no areas of interest selected.",
  };
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
