"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit } from "@/lib/audit";
import {
  sniffImageType, tokenFromFileName, COVER_EXTENSIONS, COVER_MIME_TYPES,
} from "@/lib/cover-match";
import { backfillCovers, describeTally } from "@/lib/cover-images";

/**
 * Managing the pool of common cover images.
 *
 * Cover art is bibliographic presentation, so this is CATALOGUE-edit work, the
 * same gate as every other bib operation.
 */
async function requireCataloguer(): Promise<{ name: string } | null> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "CATALOGUE")) return null;
  return { name: admin!.name };
}

const NO_PERMISSION = {
  ok: false as const,
  message: "You don't have permission to manage cover images.",
};

/**
 * Per-file and per-request ceilings.
 *
 * The hosting platform caps a server action body at about 4.5MB and next.config
 * sets 4mb, so a request that exceeds it fails in the platform with no useful
 * message. These limits sit under that deliberately, and the screen states them
 * so staff hit a sentence rather than a wall. A house cover is a small flat
 * image; a megabyte is already generous.
 */
const MAX_FILE_BYTES = 1_200_000;
const MAX_TOTAL_BYTES = 3_200_000;
const MAX_FILES = 12;
const FILENAME_MAX = 120;

/** Keep a file name printable and free of path parts, without silently renaming. */
function cleanFileName(raw: string): string {
  const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  return base
    // Only control characters go. Spaces, hyphens and underscores are the
    // separators the match token is derived from, so stripping them here would
    // quietly change what a file matches: defence-01.png would become
    // defence01.png, whose token is "defence01" and matches no collection.
    // Written as escapes, never as literal bytes: a raw control character in
    // source survives one save and breaks the next tool that reads the file.
    .replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, FILENAME_MAX);
}

export async function uploadCoverImages(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireCataloguer();
  if (!actor) return NO_PERMISSION;

  const entries = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (entries.length === 0) return { ok: false, message: "Choose at least one image to upload." };
  if (entries.length > MAX_FILES) {
    return { ok: false, message: `Upload at most ${MAX_FILES} images at a time.` };
  }

  const total = entries.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_TOTAL_BYTES) {
    return {
      ok: false,
      message: `That is ${Math.round(total / 1000)}KB in one upload; the limit is ${Math.round(MAX_TOTAL_BYTES / 1000)}KB. Send fewer files at a time.`,
    };
  }

  let added = 0;
  const refused: string[] = [];

  for (const file of entries) {
    const fileName = cleanFileName(file.name);
    if (!fileName) {
      refused.push("a file with no usable name");
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      refused.push(`${fileName}: ${Math.round(file.size / 1000)}KB exceeds the ${Math.round(MAX_FILE_BYTES / 1000)}KB limit`);
      continue;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    // The declared type is not evidence. Read the magic bytes, and refuse
    // anything that is not one of the four raster formats: an SVG accepted here
    // would be script served from this origin.
    const mimeType = sniffImageType(bytes);
    if (!mimeType) {
      refused.push(`${fileName}: not a ${COVER_MIME_TYPES.map((m) => COVER_EXTENSIONS[m]).join(", ")} image`);
      continue;
    }

    try {
      await prisma.coverImage.create({
        data: {
          fileName,
          token: tokenFromFileName(fileName),
          mimeType,
          sizeBytes: bytes.byteLength,
          bytes: Buffer.from(bytes),
          uploadedBy: actor.name,
        },
      });
      added++;
    } catch (e) {
      // fileName is unique: re-uploading the same name is a duplicate, not an
      // error worth failing the whole batch for.
      if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") {
        refused.push(`${fileName}: already in the pool`);
        continue;
      }
      throw e;
    }
  }

  if (added > 0) {
    await audit({
      action: "covers.upload",
      entity: "CoverImage",
      summary: `Uploaded ${added} common cover image(s)`,
      detail: { added, refused },
    });
    revalidatePath("/admin/catalogue/covers");
  }

  if (added === 0) {
    return { ok: false, message: `Nothing uploaded. ${refused.join("; ")}` };
  }
  return {
    ok: true,
    message:
      `${added} image${added === 1 ? "" : "s"} added.` +
      (refused.length ? ` ${refused.length} refused: ${refused.join("; ")}` : ""),
  };
}

export async function setCoverImageEnabled(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireCataloguer();
  if (!actor) return NO_PERMISSION;

  const id = String(formData.get("id") ?? "");
  const enabled = String(formData.get("enabled") ?? "") === "1";
  const image = await prisma.coverImage.findUnique({ where: { id }, select: { fileName: true } });
  if (!image) return { ok: false, message: "That cover image no longer exists." };

  await prisma.coverImage.update({ where: { id }, data: { enabled } });
  await audit({
    action: "covers.setEnabled",
    entity: "CoverImage",
    entityId: id,
    summary: `${enabled ? "Enabled" : "Retired"} cover image ${image.fileName}`,
    detail: { fileName: image.fileName, enabled },
  });
  revalidatePath("/admin/catalogue/covers");
  return {
    ok: true,
    message: enabled
      ? `${image.fileName} is back in the pool.`
      : `${image.fileName} retired. Records already using it keep it.`,
  };
}

export async function deleteCoverImage(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireCataloguer();
  if (!actor) return NO_PERMISSION;

  const id = String(formData.get("id") ?? "");
  const image = await prisma.coverImage.findUnique({
    where: { id },
    select: { fileName: true, _count: { select: { resources: true } } },
  });
  if (!image) return { ok: false, message: "That cover image no longer exists." };

  const inUse = image._count.resources;
  await prisma.coverImage.delete({ where: { id } });
  await audit({
    action: "covers.delete",
    entity: "CoverImage",
    entityId: id,
    summary: `Deleted cover image ${image.fileName}`,
    detail: { fileName: image.fileName, recordsAffected: inUse },
  });
  revalidatePath("/admin/catalogue/covers");
  revalidatePath("/admin/catalogue");
  // The relation is SetNull, so records fall back to their coloured placeholder
  // rather than being deleted with the image. Say how many, because a silent
  // change to 40 records is exactly the kind of thing staff should be told.
  return {
    ok: true,
    message:
      `${image.fileName} deleted.` +
      (inUse > 0
        ? ` ${inUse} record${inUse === 1 ? "" : "s"} went back to the coloured placeholder. Retiring instead of deleting keeps a cover in place.`
        : ""),
  };
}

/**
 * Give existing coverless records a cover from the pool.
 *
 * Assignment happens at import, so a pool uploaded today does nothing for the
 * records already catalogued. This fills that gap once, and only ever fills a
 * null, so it can be run again safely.
 */
export async function backfillCoverImages(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const actor = await requireCataloguer();
  if (!actor) return NO_PERMISSION;

  const tally = await backfillCovers();
  if (tally.considered === 0) {
    // backfillCovers returns considered: 0 both when nothing needs a cover AND
    // when the pool is empty, so the reason has to be established here rather
    // than guessed at. Claiming "every record already has a cover" while the
    // pool is empty is the opposite of the truth.
    const poolSize = await prisma.coverImage.count({ where: { enabled: true } });
    return {
      ok: true,
      message:
        poolSize === 0
          ? "No images in the pool, so nothing was assigned. Upload one first."
          : "Every record already has a cover image.",
    };
  }
  const described = describeTally(tally);
  if (!described) {
    return {
      ok: true,
      message: `Checked ${tally.considered} record(s) with no cover; the pool had no suitable image, so none were changed. Add a general image to cover the rest.`,
    };
  }
  await audit({
    action: "covers.backfill",
    entity: "Resource",
    summary: `Backfilled ${tally.assigned} cover image(s) across ${tally.considered} record(s)`,
    detail: tally,
  });
  revalidatePath("/admin/catalogue/covers");
  revalidatePath("/admin/catalogue");
  return { ok: true, message: `${described}, from ${tally.considered} record(s) checked.` };
}
