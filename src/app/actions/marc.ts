"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit } from "@/lib/audit";
import { emitEventAfter } from "@/lib/webhooks";
import { DEFAULT_TAG_DEFS, parseSubfields, type Subfield } from "@/lib/marc-tags";

// Cataloguing is CATALOGUE-edit work, like every other bib operation.
async function requireCataloguer(): Promise<{ name: string } | null> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "CATALOGUE")) return null;
  return { name: admin!.name };
}

const NO_PERMISSION = {
  ok: false as const,
  message: "You don't have permission to catalogue records.",
};

const clip = (v: FormDataEntryValue | null, n: number) => String(v ?? "").trim().slice(0, n);
const VALUE_MAX = 8000;

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

/** One indicator character; blank is stored as a space, never as "". */
function indicator(raw: string): string {
  const v = raw.replace(/_/g, " ");
  return v.length === 0 ? " " : v.slice(0, 1);
}

/**
 * Subfields arrive as parallel `sfCode[]` / `sfValue[]` arrays so the editor
 * can add and remove rows without an index scheme.
 */
function subfieldsFromForm(formData: FormData): Subfield[] {
  const codes = formData.getAll("sfCode").map(String);
  const values = formData.getAll("sfValue").map(String);
  const out: Subfield[] = [];
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i].trim().slice(0, 1);
    const value = (values[i] ?? "").trim().slice(0, VALUE_MAX);
    if (!code || !value) continue; // a blank row is how the editor deletes one
    out.push({ code, value });
  }
  return out;
}

/* ---------- MARC fields on a bib record ---------- */

export async function saveMarcField(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCataloguer();
  if (!admin) return NO_PERMISSION;

  const resourceId = clip(formData.get("resourceId"), 40);
  const fieldId = clip(formData.get("fieldId"), 40);
  const tag = clip(formData.get("tag"), 3);
  if (!resourceId) return { ok: false, message: "Missing record." };
  if (!/^[0-9A-Z]{3}$/.test(tag))
    return { ok: false, message: "Tag must be three characters, e.g. 245 or 950." };

  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { title: true },
  });
  if (!resource) return { ok: false, message: "That record no longer exists." };

  const def = await prisma.marcTagDef.findUnique({ where: { tag } });
  const isControl = def?.isControl ?? /^00\d$/.test(tag);

  const value = isControl ? clip(formData.get("value"), VALUE_MAX) : null;
  const subfields = isControl ? [] : subfieldsFromForm(formData);
  if (isControl && !value) return { ok: false, message: `Field ${tag} needs a value.` };
  if (!isControl && subfields.length === 0)
    return { ok: false, message: `Field ${tag} needs at least one subfield with a value.` };

  // Repeatability is enforced from the tag definition, not assumed.
  if (!fieldId && def && !def.repeatable) {
    const existing = await prisma.marcField.count({ where: { resourceId, tag } });
    if (existing > 0)
      return { ok: false, message: `${tag} (${def.label}) is not repeatable — edit the existing field instead.` };
  }

  const data = {
    tag,
    ind1: indicator(String(formData.get("ind1") ?? " ")),
    ind2: indicator(String(formData.get("ind2") ?? " ")),
    value,
    subfields,
  };

  if (fieldId) {
    const before = await prisma.marcField.findUnique({ where: { id: fieldId } });
    if (!before) return { ok: false, message: "That field no longer exists." };
    await prisma.marcField.update({ where: { id: fieldId }, data });
    await audit({
      action: "marc.field.update",
      summary: `Edited ${tag} on "${resource.title}"`,
      entity: "Resource",
      entityId: resourceId,
      detail: { tag, before: { ind1: before.ind1, ind2: before.ind2, subfields: before.subfields }, after: data },
    });
  } else {
    const max = await prisma.marcField.aggregate({
      where: { resourceId },
      _max: { seq: true },
    });
    await prisma.marcField.create({
      data: { ...data, resourceId, seq: (max._max.seq ?? 0) + 1 },
    });
    await audit({
      action: "marc.field.create",
      summary: `Added ${tag} to "${resource.title}"`,
      entity: "Resource",
      entityId: resourceId,
      detail: data,
    });
  }

  emitEventAfter("resource.updated", { id: resourceId, title: resource.title });
  revalidatePath(`/admin/catalogue/${resourceId}`);
  return { ok: true, message: `Field ${tag} saved.` };
}

export async function deleteMarcField(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCataloguer();
  if (!admin) return NO_PERMISSION;

  const fieldId = clip(formData.get("fieldId"), 40);
  const field = await prisma.marcField.findUnique({
    where: { id: fieldId },
    include: { resource: { select: { id: true, title: true } } },
  });
  if (!field) return { ok: false, message: "That field no longer exists." };

  await prisma.marcField.delete({ where: { id: fieldId } });
  await audit({
    action: "marc.field.delete",
    summary: `Removed ${field.tag} from "${field.resource.title}"`,
    entity: "Resource",
    entityId: field.resource.id,
    detail: { tag: field.tag, subfields: field.subfields },
  });
  revalidatePath(`/admin/catalogue/${field.resource.id}`);
  return { ok: true, message: `Field ${field.tag} removed.` };
}

/* ---------- Information Context: tag definitions ---------- */

export async function saveTagDef(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCataloguer();
  if (!admin) return NO_PERMISSION;

  const tag = clip(formData.get("tag"), 3).toUpperCase();
  if (!/^[0-9A-Z]{3}$/.test(tag))
    return { ok: false, message: "Tag must be three characters, e.g. 245." };
  const label = clip(formData.get("label"), 120);
  if (!label) return { ok: false, message: "A display label is required." };

  // "a=Title, b=Subtitle" — the compact form cataloguers actually type.
  const subfieldSpec = clip(formData.get("subfieldSpec"), 1000);
  const subfields = subfieldSpec
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [code, ...rest] = part.split("=");
      return { code: code.trim().slice(0, 1), label: rest.join("=").trim() || code.trim() };
    })
    .filter((s) => s.code);

  const data = {
    tag,
    alias: clip(formData.get("alias"), 60) || null,
    label,
    description: clip(formData.get("description"), 500) || null,
    repeatable: formData.get("repeatable") === "on",
    isControl: /^00\d$/.test(tag),
    local: /^9\d\d$/.test(tag),
    subfields,
    sortOrder: parseInt(clip(formData.get("sortOrder"), 6), 10) || 500,
  };

  try {
    const existing = await prisma.marcTagDef.findUnique({ where: { tag } });
    if (existing) await prisma.marcTagDef.update({ where: { tag }, data });
    else await prisma.marcTagDef.create({ data });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, message: `Tag ${tag} already exists.` };
    throw e;
  }

  await audit({
    action: "marc.tagdef.save",
    summary: `Saved MARC tag definition ${tag} — ${label}`,
    entity: "MarcTagDef",
  });
  revalidatePath("/admin/cataloguing");
  return { ok: true, message: `Tag ${tag} saved.` };
}

export async function deleteTagDef(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCataloguer();
  if (!admin) return NO_PERMISSION;

  const tag = clip(formData.get("tag"), 3);
  // Definitions describe fields; removing one must not orphan catalogued data.
  const inUse = await prisma.marcField.count({ where: { tag } });
  if (inUse > 0)
    return {
      ok: false,
      message: `${inUse} record${inUse === 1 ? "" : "s"} still use tag ${tag} — the definition can't be removed while it's in use.`,
    };
  await prisma.marcTagDef.delete({ where: { tag } }).catch(() => {});
  await audit({ action: "marc.tagdef.delete", summary: `Deleted MARC tag definition ${tag}`, entity: "MarcTagDef" });
  revalidatePath("/admin/cataloguing");
  return { ok: true, message: `Tag ${tag} definition removed.` };
}

/** Restore the shipped MARC 21 starter set without touching staff edits. */
export async function restoreDefaultTags(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const admin = await requireCataloguer();
  if (!admin) return NO_PERMISSION;

  let added = 0;
  for (const d of DEFAULT_TAG_DEFS) {
    const existing = await prisma.marcTagDef.findUnique({ where: { tag: d.tag } });
    if (existing) continue;
    await prisma.marcTagDef.create({
      data: {
        tag: d.tag, alias: d.alias ?? null, label: d.label,
        description: d.description ?? null, repeatable: d.repeatable ?? false,
        isControl: d.isControl ?? false, local: d.local ?? false,
        subfields: d.subfields ?? [], sortOrder: d.sortOrder,
      },
    });
    added++;
  }
  await audit({
    action: "marc.tagdef.restore",
    summary: `Restored ${added} default MARC tag definition${added === 1 ? "" : "s"}`,
    entity: "MarcTagDef",
  });
  revalidatePath("/admin/cataloguing");
  return {
    ok: true,
    message: added === 0 ? "All default tags are already defined." : `Added ${added} missing default tag${added === 1 ? "" : "s"}.`,
  };
}

/* ---------- Authorities ---------- */

export async function saveAuthorityType(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCataloguer();
  if (!admin) return NO_PERMISSION;

  const code = clip(formData.get("code"), 20).toUpperCase().replace(/\s+/g, "_");
  const name = clip(formData.get("name"), 80);
  if (!code || !name) return { ok: false, message: "Code and name are required." };
  const marcTag = clip(formData.get("marcTag"), 3) || null;

  try {
    await prisma.authorityType.create({ data: { code, name, marcTag } });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, message: `Authority type ${code} already exists.` };
    throw e;
  }
  await audit({ action: "marc.authorityType.create", summary: `Added authority type ${code} — ${name}`, entity: "AuthorityType" });
  revalidatePath("/admin/cataloguing");
  return { ok: true, message: `${code} added.` };
}

export async function saveAuthority(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCataloguer();
  if (!admin) return NO_PERMISSION;

  const typeId = clip(formData.get("typeId"), 40);
  const heading = clip(formData.get("heading"), 300);
  if (!typeId) return { ok: false, message: "Choose an authority type." };
  if (!heading) return { ok: false, message: "A heading is required." };
  const uri = clip(formData.get("uri"), 500) || null;
  if (uri && !/^https?:\/\//i.test(uri))
    return { ok: false, message: "The linked-data URI must start with http:// or https://." };

  const data = {
    typeId,
    heading,
    seeAlso: clip(formData.get("seeAlso"), 300) || null,
    uri,
    note: clip(formData.get("note"), 500) || null,
  };
  try {
    const id = clip(formData.get("id"), 40);
    if (id) await prisma.authority.update({ where: { id }, data });
    else await prisma.authority.create({ data });
  } catch (e) {
    if (isUniqueViolation(e))
      return { ok: false, message: `"${heading}" already exists for that authority type.` };
    throw e;
  }
  await audit({ action: "marc.authority.save", summary: `Saved authority heading "${heading}"`, entity: "Authority" });
  revalidatePath("/admin/cataloguing");
  return { ok: true, message: `"${heading}" saved.` };
}

export async function deleteAuthority(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCataloguer();
  if (!admin) return NO_PERMISSION;
  const id = clip(formData.get("id"), 40);
  const a = await prisma.authority.findUnique({ where: { id } });
  if (!a) return { ok: false, message: "That heading no longer exists." };
  await prisma.authority.delete({ where: { id } });
  await audit({ action: "marc.authority.delete", summary: `Deleted authority heading "${a.heading}"`, entity: "Authority", entityId: id });
  revalidatePath("/admin/cataloguing");
  return { ok: true, message: "Heading removed." };
}

/* ---------- Domain codes and interest topics ---------- */

export async function saveDomainCode(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCataloguer();
  if (!admin) return NO_PERMISSION;

  const code = clip(formData.get("code"), 20).toUpperCase().replace(/\s+/g, "_");
  const name = clip(formData.get("name"), 120);
  if (!code || !name) return { ok: false, message: "Code and name are required." };
  try {
    await prisma.domainCode.create({ data: { code, name } });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, message: `Domain code ${code} already exists.` };
    throw e;
  }
  await audit({ action: "marc.domain.create", summary: `Added domain code ${code} — ${name}`, entity: "DomainCode" });
  revalidatePath("/admin/cataloguing");
  return { ok: true, message: `${code} added.` };
}

export async function saveInterestTopic(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCataloguer();
  if (!admin) return NO_PERMISSION;

  const domainId = clip(formData.get("domainId"), 40);
  const name = clip(formData.get("name"), 120);
  if (!domainId || !name) return { ok: false, message: "Choose a domain and give the topic a name." };
  try {
    await prisma.interestTopic.create({ data: { domainId, name } });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, message: `"${name}" already exists under that domain.` };
    throw e;
  }
  await audit({ action: "marc.topic.create", summary: `Added interest topic "${name}"`, entity: "InterestTopic" });
  revalidatePath("/admin/cataloguing");
  return { ok: true, message: `"${name}" added.` };
}

export async function deleteDomainOrTopic(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCataloguer();
  if (!admin) return NO_PERMISSION;
  const kind = clip(formData.get("kind"), 10);
  const id = clip(formData.get("id"), 40);
  if (kind === "topic") {
    await prisma.interestTopic.delete({ where: { id } }).catch(() => {});
    await audit({ action: "marc.topic.delete", summary: "Deleted an interest topic", entity: "InterestTopic", entityId: id });
  } else {
    await prisma.domainCode.delete({ where: { id } }).catch(() => {});
    await audit({ action: "marc.domain.delete", summary: "Deleted a domain code and its topics", entity: "DomainCode", entityId: id });
  }
  revalidatePath("/admin/cataloguing");
  return { ok: true, message: "Removed." };
}

export { parseSubfields };
