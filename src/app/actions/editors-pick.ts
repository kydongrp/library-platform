"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { listCategories } from "@/lib/categories";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { RESOURCE_TYPES, defaultDesignationFor } from "@/lib/constants";
import { coverColorFor } from "@/lib/ingest";
import { audit } from "@/lib/audit";

// Editor's Pick management (BR-366E/F/G/I, 404). Curation is catalogue work,
// so every mutation is gated on CATALOGUE edit rights.

const EP_PATHS = ["/admin/editors-pick", "/admin/catalogue"];
function revalidateEp() {
  for (const p of EP_PATHS) revalidatePath(p);
}

async function requireCatalogueEditor(): Promise<{ name: string } | null> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "CATALOGUE")) return null;
  return { name: admin!.name };
}

// Server-side length caps: these strings persist to unbounded TEXT columns
// and render back into the admin UI.
const clip = (v: FormDataEntryValue | null, n: number) => String(v ?? "").trim().slice(0, n);
const NOTE_MAX = 500; // blurb / reason / staff note
const NAME_MAX = 200; // authors / provider / submitter
const TITLE_MAX = 300;
const URL_MAX = 2000;

/** Unique-constraint violation (digitalUrl): the check-then-write race backstop. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

/** Promote an existing catalogue title to Editor's Pick (internal pick). */
export async function promoteToEditorsPick(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCatalogueEditor();
  if (!admin) return { ok: false, message: "You don't have permission to curate Editor's Picks." };

  const resourceId = String(formData.get("resourceId") ?? "");
  const blurb = clip(formData.get("blurb"), NOTE_MAX) || null;
  if (!resourceId) return { ok: false, message: "Pick a catalogue title to promote." };

  const resource = await prisma.resource.findUnique({ where: { id: resourceId } });
  if (!resource) return { ok: false, message: "That title no longer exists." };
  if (resource.editorsPick)
    return { ok: false, message: `"${resource.title}" is already an Editor's Pick.` };

  await prisma.resource.update({
    where: { id: resourceId },
    data: {
      editorsPick: true,
      epExternal: false,
      epBlurb: blurb,
      epPickedAt: new Date(),
      epPickedBy: admin.name,
    },
  });
  await audit({ action: "ep.promote", summary: `Promoted "${resource.title}" to Editor's Picks`, entity: "Resource", entityId: resourceId });
  revalidateEp();
  return { ok: true, message: `"${resource.title}" promoted to Editor's Pick.` };
}

/**
 * Add an external resource straight onto the Editor's Pick shelf (BR-366F),
 * e.g. a link a learner sent over WhatsApp. Created as a digital link-out
 * resource flagged epExternal, so removing it from the picks later deletes it
 * from the library entirely (BR-366G).
 */
export async function addExternalPick(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCatalogueEditor();
  if (!admin) return { ok: false, message: "You don't have permission to curate Editor's Picks." };

  const title = clip(formData.get("title"), TITLE_MAX);
  const url = clip(formData.get("url"), URL_MAX);
  if (!title) return { ok: false, message: "Title is required." };
  if (!/^https?:\/\//i.test(url))
    return { ok: false, message: "A valid access URL (https://…) is required." };

  const authors = clip(formData.get("authors"), NAME_MAX) || "Unknown";
  const provider = clip(formData.get("provider"), NAME_MAX) || "External";
  const rawType = String(formData.get("type") ?? "EBOOK");
  const type = (RESOURCE_TYPES as readonly string[]).includes(rawType) ? rawType : "EBOOK";
  const rawCategory = String(formData.get("category") ?? "");
  const allowedCategories = await listCategories();
  const category = allowedCategories.includes(rawCategory)
    ? rawCategory
    : "Technology";
  const blurb = clip(formData.get("blurb"), NOTE_MAX) || null;

  const dup = await prisma.resource.findFirst({
    where: { digitalUrl: url },
    select: { title: true },
  });
  if (dup) return { ok: false, message: `That URL is already in the library ("${dup.title}").` };

  try {
    await prisma.resource.create({
      data: {
        title,
        author: authors,
        type,
        materialDesignation: defaultDesignationFor(type),
        category,
        publisher: provider,
        coverColor: coverColorFor(provider + title),
        digital: true,
        digitalUrl: url,
        provider,
        editorsPick: true,
        epExternal: true,
        epBlurb: blurb,
        epPickedAt: new Date(),
        epPickedBy: admin.name,
      },
    });
  } catch (e) {
    if (isUniqueViolation(e))
      return { ok: false, message: "That URL is already in the library." };
    throw e;
  }
  await audit({ action: "ep.addExternal", summary: `Added external pick "${title}" (${provider})`, entity: "Resource", detail: { url, provider } });
  revalidateEp();
  return { ok: true, message: `External pick "${title}" added to Editor's Picks.` };
}

/** Edit a pick: blurb for any pick; title/authors/URL only for external ones. */
export async function updatePick(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCatalogueEditor();
  if (!admin) return { ok: false, message: "You don't have permission to curate Editor's Picks." };

  const id = String(formData.get("id") ?? "");
  const resource = await prisma.resource.findUnique({ where: { id } });
  if (!resource || !resource.editorsPick)
    return { ok: false, message: "That Editor's Pick no longer exists." };

  const blurb = clip(formData.get("blurb"), NOTE_MAX) || null;
  const data: {
    epBlurb: string | null;
    title?: string;
    author?: string;
    digitalUrl?: string;
    type?: string;
    category?: string;
  } = { epBlurb: blurb };

  if (resource.epExternal) {
    const title = clip(formData.get("title"), TITLE_MAX);
    const url = clip(formData.get("url"), URL_MAX);
    if (!title) return { ok: false, message: "Title is required." };
    if (!/^https?:\/\//i.test(url))
      return { ok: false, message: "A valid access URL (https://…) is required." };
    if (url !== resource.digitalUrl) {
      const clash = await prisma.resource.findFirst({
        where: { digitalUrl: url, NOT: { id } },
        select: { title: true },
      });
      if (clash) return { ok: false, message: `That URL already belongs to "${clash.title}".` };
    }
    data.title = title;
    data.author = clip(formData.get("authors"), NAME_MAX) || "Unknown";
    data.digitalUrl = url;
    const rawType = String(formData.get("type") ?? "");
    if ((RESOURCE_TYPES as readonly string[]).includes(rawType)) data.type = rawType;
    const rawCategory = String(formData.get("category") ?? "");
    if ((await listCategories()).includes(rawCategory)) data.category = rawCategory;
  }

  try {
    await prisma.resource.update({ where: { id }, data });
  } catch (e) {
    if (isUniqueViolation(e))
      return { ok: false, message: "That URL already belongs to another title." };
    throw e;
  }
  await audit({ action: "ep.update", summary: `Edited pick "${data.title ?? resource.title}"`, entity: "Resource", entityId: id, detail: data });
  revalidateEp();
  return { ok: true, message: "Pick updated." };
}

/**
 * Remove a title from Editor's Picks with the BR-366G/366I split:
 * external picks are deleted from the library entirely; internal picks only
 * lose the Editor's Pick flag and stay in the catalogue.
 */
export async function removeFromEditorsPick(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCatalogueEditor();
  if (!admin) return { ok: false, message: "You don't have permission to curate Editor's Picks." };

  const id = String(formData.get("id") ?? "");
  const resource = await prisma.resource.findUnique({ where: { id } });
  if (!resource || !resource.editorsPick)
    return { ok: false, message: "That Editor's Pick no longer exists." };

  // Safety net: an "external" pick that has since grown physical copies or
  // loan history has become part of the collection. Never hard-delete it.
  const [copies, loans] = resource.epExternal
    ? await Promise.all([
        prisma.copy.count({ where: { resourceId: id } }),
        prisma.loan.count({ where: { resourceId: id } }),
      ])
    : [0, 0];

  if (resource.epExternal && copies === 0 && loans === 0) {
    await prisma.reservation.deleteMany({ where: { resourceId: id } });
    await prisma.linkCheck.deleteMany({ where: { resourceId: id } });
    await prisma.resource.delete({ where: { id } });
    await audit({ action: "ep.removeExternal", summary: `Removed external pick "${resource.title}" and deleted it from the library (BR-366G)`, entity: "Resource", entityId: id, detail: { title: resource.title, digitalUrl: resource.digitalUrl } });
    revalidateEp();
    return { ok: true, message: `External pick "${resource.title}" removed from the library.` };
  }

  await prisma.resource.update({
    where: { id },
    data: { editorsPick: false, epExternal: false, epBlurb: null, epPickedAt: null, epPickedBy: null },
  });
  await audit({ action: "ep.removeInternal", summary: `Removed "${resource.title}" from Editor's Picks (kept in catalogue)`, entity: "Resource", entityId: id });
  revalidateEp();
  return {
    ok: true,
    message:
      resource.epExternal
        ? `"${resource.title}" has copies or loan history, so it was kept in the catalogue; only the pick was removed.`
        : `"${resource.title}" removed from Editor's Picks. It is still in the catalogue.`,
  };
}

/**
 * Demote an external pick to internal ("keep in catalogue"): the title stays
 * on the shelf, but removing it later will no longer delete it from the
 * library. Used when an external pick has effectively joined the collection.
 */
export async function keepPickInCatalogue(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCatalogueEditor();
  if (!admin) return { ok: false, message: "You don't have permission to curate Editor's Picks." };

  const id = String(formData.get("id") ?? "");
  const r = await prisma.resource.updateMany({
    where: { id, editorsPick: true, epExternal: true },
    data: { epExternal: false },
  });
  if (r.count === 0) return { ok: false, message: "That external pick no longer exists." };
  await audit({ action: "ep.keepInCatalogue", summary: "External pick demoted to internal (kept in catalogue)", entity: "Resource", entityId: id });
  revalidateEp();
  return { ok: true, message: "Marked as part of the collection. Removal will no longer delete it." };
}

/* ---------- Submission queue (form.sg / WhatsApp intake) ---------- */

/**
 * Record a learner submission retrieved from form.sg or WhatsApp. Internal
 * nominations reference a catalogue title; external ones carry their own
 * title/URL so approval can create the resource in one click.
 */
export async function recordSubmission(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCatalogueEditor();
  if (!admin) return { ok: false, message: "You don't have permission to record submissions." };

  const kind = String(formData.get("kind") ?? "INTERNAL") === "EXTERNAL" ? "EXTERNAL" : "INTERNAL";
  const rawChannel = String(formData.get("channel") ?? "FORMSG");
  const channel = ["FORMSG", "WHATSAPP", "OTHER"].includes(rawChannel) ? rawChannel : "OTHER";
  const submitter = clip(formData.get("submitter"), NAME_MAX) || null;
  const reason = clip(formData.get("reason"), NOTE_MAX) || null;

  if (kind === "INTERNAL") {
    const resourceId = String(formData.get("resourceId") ?? "");
    if (!resourceId) return { ok: false, message: "Pick the nominated catalogue title." };
    const resource = await prisma.resource.findUnique({ where: { id: resourceId } });
    if (!resource) return { ok: false, message: "That title no longer exists." };
    await prisma.epSubmission.create({
      data: { kind, channel, submitter, reason, resourceId },
    });
  } else {
    const title = clip(formData.get("title"), TITLE_MAX);
    const url = clip(formData.get("url"), URL_MAX);
    if (!title) return { ok: false, message: "Title is required for an external submission." };
    if (!/^https?:\/\//i.test(url))
      return { ok: false, message: "A valid URL (https://…) is required for an external submission." };
    await prisma.epSubmission.create({
      data: {
        kind,
        channel,
        submitter,
        reason,
        title,
        url,
        authors: clip(formData.get("authors"), NAME_MAX) || null,
        provider: clip(formData.get("provider"), NAME_MAX) || null,
      },
    });
  }

  revalidatePath("/admin/editors-pick");
  await audit({ action: "ep.recordSubmission", summary: `Recorded ${kind.toLowerCase()} nomination via ${channel}`, entity: "EpSubmission", detail: { kind, channel, submitter } });
  return { ok: true, message: "Submission recorded. Approve it below to promote." };
}

/**
 * Approve a pending submission: promotes the title (or creates the external
 * pick). The PENDING→APPROVED transition is claimed atomically first, so two
 * concurrent decisions can't both act; if promotion then fails validation, the
 * claim is released back to PENDING.
 */
export async function approveSubmission(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCatalogueEditor();
  if (!admin) return { ok: false, message: "You don't have permission to decide submissions." };

  const id = String(formData.get("id") ?? "");
  // Atomic claim: loses the race politely instead of double-acting.
  const claimed = await prisma.epSubmission.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "APPROVED", decidedBy: admin.name },
  });
  if (claimed.count === 0)
    return { ok: false, message: "That submission is gone or already decided." };

  const release = async (message: string): Promise<ActionState> => {
    await prisma.epSubmission.updateMany({
      where: { id, status: "APPROVED" },
      data: { status: "PENDING", decidedBy: null },
    });
    return { ok: false, message };
  };

  const sub = await prisma.epSubmission.findUnique({ where: { id }, include: { resource: true } });
  if (!sub) return { ok: false, message: "That submission disappeared." };

  const pickData = {
    editorsPick: true,
    epExternal: false,
    epBlurb: sub.reason,
    epPickedAt: new Date(),
    epPickedBy: admin.name,
  };

  if (sub.kind === "INTERNAL") {
    if (!sub.resource)
      return release("The nominated title was deleted. Reject this submission instead.");
    if (sub.resource.editorsPick) {
      await audit({ action: "ep.approve", summary: `Approved nomination: "${sub.resource.title}" was already a pick`, entity: "EpSubmission", entityId: id });
      revalidateEp();
      return {
        ok: true,
        message: `"${sub.resource.title}" is already an Editor's Pick. Nomination closed, existing note kept.`,
      };
    }
    await prisma.resource.update({ where: { id: sub.resource.id }, data: pickData });
    await audit({ action: "ep.approve", summary: `Approved nomination: promoted "${sub.resource.title}"`, entity: "EpSubmission", entityId: id });
    revalidateEp();
    return { ok: true, message: `"${sub.resource.title}" promoted to Editor's Picks.` };
  }

  // EXTERNAL
  if (!sub.title || !sub.url || !/^https?:\/\//i.test(sub.url))
    return release("This external submission is missing a valid title/URL. Reject it instead.");

  // Promote an already-catalogued title in place as an INTERNAL pick: it
  // exists independently of the shelf, so removal must never delete it.
  const promoteExisting = async (): Promise<ActionState | null> => {
    const dup = await prisma.resource.findFirst({
      where: { digitalUrl: sub.url },
      select: { id: true, title: true, editorsPick: true },
    });
    if (!dup) return null;
    if (dup.editorsPick) {
      await audit({ action: "ep.approve", summary: `Approved nomination: "${dup.title}" already featured`, entity: "EpSubmission", entityId: id });
      revalidateEp();
      return { ok: true, message: `"${dup.title}" is already featured. Nomination closed.` };
    }
    await prisma.resource.update({ where: { id: dup.id }, data: pickData });
    await audit({ action: "ep.approve", summary: `Approved nomination: promoted existing title "${dup.title}"`, entity: "EpSubmission", entityId: id });
    revalidateEp();
    return {
      ok: true,
      message: `That URL was already in the catalogue. Promoted the existing title "${dup.title}" instead.`,
    };
  };

  const existing = await promoteExisting();
  if (existing) return existing;

  const provider = sub.provider || "External";
  try {
    await prisma.resource.create({
      data: {
        title: sub.title,
        author: sub.authors || "Unknown",
        type: "EBOOK",
        category: "Technology",
        publisher: provider,
        coverColor: coverColorFor(provider + sub.title),
        digital: true,
        digitalUrl: sub.url,
        provider,
        ...pickData,
        epExternal: true,
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      // Lost a race with an importer: promote whatever claimed the URL.
      const raced = await promoteExisting();
      if (raced) return raced;
    }
    // Unexpected failure: release the claim so the nomination isn't stranded.
    await prisma.epSubmission.updateMany({
      where: { id, status: "APPROVED" },
      data: { status: "PENDING", decidedBy: null },
    });
    throw e;
  }
  await audit({ action: "ep.approve", summary: `Approved nomination: created external pick "${sub.title}"`, entity: "EpSubmission", entityId: id, detail: { url: sub.url, provider } });
  revalidateEp();
  return { ok: true, message: `External pick "${sub.title}" created and promoted to Editor's Picks.` };
}

/** Reject a pending submission with an optional note (atomic transition). */
export async function rejectSubmission(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCatalogueEditor();
  if (!admin) return { ok: false, message: "You don't have permission to decide submissions." };

  const id = String(formData.get("id") ?? "");
  const r = await prisma.epSubmission.updateMany({
    where: { id, status: "PENDING" },
    data: {
      status: "REJECTED",
      decidedBy: admin.name,
      staffNote: clip(formData.get("staffNote"), NOTE_MAX) || null,
    },
  });
  if (r.count === 0)
    return { ok: false, message: "That submission is gone or already decided." };
  await audit({ action: "ep.reject", summary: "Rejected Editor's Pick nomination", entity: "EpSubmission", entityId: id });
  revalidatePath("/admin/editors-pick");
  return { ok: true, message: "Submission rejected." };
}

/* ---------- Auto-curation suggestions ---------- */

/** Staff "no" to a suggested title: it is never suggested again. */
export async function dismissSuggestion(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCatalogueEditor();
  if (!admin) return { ok: false, message: "You don't have permission to curate Editor's Picks." };

  const resourceId = String(formData.get("resourceId") ?? "");
  if (!resourceId) return { ok: false, message: "Missing title id." };
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { title: true },
  });
  if (!resource) return { ok: false, message: "That title no longer exists." };

  try {
    await prisma.epSuggestionDismissal.create({
      data: { resourceId, dismissedBy: admin.name },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: true, message: "Already dismissed." };
    throw e;
  }
  await audit({
    action: "ep.suggestion.dismiss",
    summary: `Dismissed auto-curation suggestion "${resource.title}"`,
    entity: "Resource",
    entityId: resourceId,
  });
  revalidatePath("/admin/editors-pick");
  return { ok: true, message: `"${resource.title}" won't be suggested again.` };
}

/** Undo a dismissal so the title can compete for suggestions again. */
export async function restoreSuggestion(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCatalogueEditor();
  if (!admin) return { ok: false, message: "You don't have permission to curate Editor's Picks." };

  const resourceId = String(formData.get("resourceId") ?? "");
  const r = await prisma.epSuggestionDismissal.deleteMany({ where: { resourceId } });
  if (r.count === 0) return { ok: false, message: "That dismissal is already gone." };
  await audit({
    action: "ep.suggestion.restore",
    summary: "Restored a dismissed auto-curation suggestion",
    entity: "Resource",
    entityId: resourceId,
  });
  revalidatePath("/admin/editors-pick");
  return { ok: true, message: "Restored. It can be suggested again." };
}
