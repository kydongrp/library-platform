"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit } from "@/lib/audit";
import { MEMBER_LANGUAGES } from "@/lib/constants";
import { parseMemberRows } from "@/lib/member-import";

// Server actions are directly invocable endpoints, so re-check rights here.
async function canEditMembers(): Promise<boolean> {
  return canEdit(await getCurrentAdmin(), "MEMBERS");
}

const clip = (v: FormDataEntryValue | null, n: number) => String(v ?? "").trim().slice(0, n);
const MAX_UPLOAD_BYTES = 3_500_000;

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

function defaultMaxLoans(memberType: string): number {
  return memberType === "STAFF" ? 10 : memberType === "EXTERNAL" ? 3 : 5;
}

async function validStatusOrDefault(raw: string): Promise<string> {
  const statuses = await prisma.memberStatus.findMany();
  const hit = statuses.find((s) => s.name.toLowerCase() === raw.toLowerCase());
  if (hit) return hit.name;
  return statuses.find((s) => s.isDefault)?.name ?? statuses[0]?.name ?? "Active";
}

async function parseMemberForm(formData: FormData) {
  const memberType = clip(formData.get("memberType"), 12) || "STUDENT";
  const maxRaw = clip(formData.get("maxLoans"), 4);
  const langRaw = clip(formData.get("language"), 20);
  const language =
    (MEMBER_LANGUAGES as readonly string[]).find((l) => l.toLowerCase() === langRaw.toLowerCase()) ??
    "English";
  return {
    name: clip(formData.get("name"), 200),
    email: clip(formData.get("email"), 200).toLowerCase(),
    memberType,
    status: await validStatusOrDefault(clip(formData.get("status"), 40)),
    phone: clip(formData.get("phone"), 40) || null,
    language,
    location: clip(formData.get("location"), 120) || null,
    department: clip(formData.get("department"), 120) || null,
    maxLoans: maxRaw ? parseInt(maxRaw, 10) : defaultMaxLoans(memberType),
  };
}

export async function createMember(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditMembers()))
    return { ok: false, message: "You don't have permission to manage members." };
  const data = await parseMemberForm(formData);
  if (!data.name) return { ok: false, message: "Name is required." };
  if (!data.email) return { ok: false, message: "Email is required." };

  const existing = await prisma.member.findUnique({ where: { email: data.email } });
  if (existing) return { ok: false, message: "A member with that email already exists." };

  const member = await prisma.member.create({ data });
  await audit({
    action: "members.create",
    summary: `Created member "${data.name}" <${data.email}> (${data.memberType}, ${data.status})`,
    entity: "Member",
    entityId: member.id,
  });
  revalidatePath("/admin/members");
  redirect(`/admin/members/${member.id}`);
}

export async function updateMember(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditMembers()))
    return { ok: false, message: "You don't have permission to manage members." };
  const id = clip(formData.get("id"), 40);
  const data = await parseMemberForm(formData);
  if (!id) return { ok: false, message: "Missing member id." };
  if (!data.name || !data.email)
    return { ok: false, message: "Name and email are required." };

  const clash = await prisma.member.findFirst({
    where: { email: data.email, NOT: { id } },
  });
  if (clash) return { ok: false, message: "Another member already uses that email." };

  const before = await prisma.member.findUnique({
    where: { id },
    select: {
      name: true, email: true, memberType: true, status: true, maxLoans: true,
      phone: true, language: true, location: true, department: true,
    },
  });
  await prisma.member.update({ where: { id }, data });
  await audit({
    action: "members.update",
    summary: `Updated member "${data.name}"`,
    entity: "Member",
    entityId: id,
    detail: { before, after: data },
  });
  revalidatePath(`/admin/members/${id}`);
  revalidatePath("/admin/members");
  return { ok: true, message: "Saved." };
}

/* ---------- Custom member statuses ---------- */

export async function createMemberStatus(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditMembers()))
    return { ok: false, message: "You don't have permission to manage member statuses." };

  const name = clip(formData.get("name"), 40);
  if (!name) return { ok: false, message: "Give the status a name (e.g. Alumni, On exchange)." };
  const canBorrow = formData.get("canBorrow") === "on";
  const makeDefault = formData.get("isDefault") === "on";

  try {
    await prisma.$transaction(async (tx) => {
      if (makeDefault) await tx.memberStatus.updateMany({ data: { isDefault: false } });
      await tx.memberStatus.create({
        data: { name, canBorrow, isDefault: makeDefault, note: clip(formData.get("note"), 200) || null },
      });
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, message: `Status "${name}" already exists.` };
    throw e;
  }
  await audit({
    action: "members.status.create",
    summary: `Created member status "${name}" (${canBorrow ? "can borrow" : "borrowing blocked"}${makeDefault ? ", default" : ""})`,
    entity: "MemberStatus",
  });
  revalidatePath("/admin/members");
  return { ok: true, message: `Status "${name}" added.` };
}

export async function toggleStatusBorrow(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditMembers()))
    return { ok: false, message: "You don't have permission to manage member statuses." };
  const id = clip(formData.get("id"), 40);
  const s = await prisma.memberStatus.findUnique({ where: { id } });
  if (!s) return { ok: false, message: "That status no longer exists." };
  await prisma.memberStatus.update({ where: { id }, data: { canBorrow: !s.canBorrow } });
  await audit({
    action: "members.status.toggleBorrow",
    summary: `Status "${s.name}": borrowing ${s.canBorrow ? "blocked" : "allowed"}`,
    entity: "MemberStatus",
    entityId: id,
  });
  revalidatePath("/admin/members");
  return { ok: true, message: `"${s.name}" members can ${s.canBorrow ? "no longer" : "now"} borrow.` };
}

export async function makeDefaultStatus(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditMembers()))
    return { ok: false, message: "You don't have permission to manage member statuses." };
  const id = clip(formData.get("id"), 40);
  const s = await prisma.memberStatus.findUnique({ where: { id } });
  if (!s) return { ok: false, message: "That status no longer exists." };
  await prisma.$transaction([
    prisma.memberStatus.updateMany({ data: { isDefault: false } }),
    prisma.memberStatus.update({ where: { id }, data: { isDefault: true } }),
  ]);
  await audit({
    action: "members.status.default",
    summary: `"${s.name}" is now the default member status`,
    entity: "MemberStatus",
    entityId: id,
  });
  revalidatePath("/admin/members");
  return { ok: true, message: `New members default to "${s.name}".` };
}

export async function deleteMemberStatus(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditMembers()))
    return { ok: false, message: "You don't have permission to manage member statuses." };
  const id = clip(formData.get("id"), 40);
  const s = await prisma.memberStatus.findUnique({ where: { id } });
  if (!s) return { ok: false, message: "That status no longer exists." };
  if (s.isDefault) return { ok: false, message: "Make another status the default first." };
  const inUse = await prisma.member.count({ where: { status: s.name } });
  if (inUse > 0)
    return { ok: false, message: `${inUse} member${inUse === 1 ? "" : "s"} still ${inUse === 1 ? "has" : "have"} status "${s.name}". Reassign them first.` };
  await prisma.memberStatus.delete({ where: { id } });
  await audit({
    action: "members.status.delete",
    summary: `Deleted member status "${s.name}"`,
    entity: "MemberStatus",
    entityId: id,
  });
  revalidatePath("/admin/members");
  return { ok: true, message: `Status "${s.name}" deleted.` };
}

/* ---------- Location and department code lists (rows 42-43) ---------- */

type RegListKind = "location" | "department";

async function createRegRow(kind: RegListKind, formData: FormData): Promise<ActionState> {
  if (!(await canEditMembers()))
    return { ok: false, message: `You don't have permission to manage member ${kind}s.` };
  const name = clip(formData.get("name"), 80);
  if (!name) return { ok: false, message: `Give the ${kind} a name.` };
  const table = kind === "location" ? prisma.memberLocation : prisma.memberDepartment;
  try {
    await (table as typeof prisma.memberLocation).create({ data: { name } });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, message: `"${name}" already exists.` };
    throw e;
  }
  await audit({
    action: `members.${kind}.create`,
    summary: `Added member ${kind} "${name}"`,
    entity: kind === "location" ? "MemberLocation" : "MemberDepartment",
  });
  revalidatePath("/admin/members");
  return { ok: true, message: `"${name}" added.` };
}

export async function createMemberLocation(_p: ActionState, f: FormData): Promise<ActionState> {
  return createRegRow("location", f);
}
export async function createMemberDepartment(_p: ActionState, f: FormData): Promise<ActionState> {
  return createRegRow("department", f);
}

async function deleteRegRow(kind: RegListKind, formData: FormData): Promise<ActionState> {
  if (!(await canEditMembers()))
    return { ok: false, message: `You don't have permission to manage member ${kind}s.` };
  const id = clip(formData.get("id"), 40);
  const table = kind === "location" ? prisma.memberLocation : prisma.memberDepartment;
  const row = await (table as typeof prisma.memberLocation).findUnique({ where: { id } });
  if (!row) return { ok: false, message: "That entry no longer exists." };
  // Members keep their stored value; the list only drives the form's choices.
  await (table as typeof prisma.memberLocation).delete({ where: { id } });
  await audit({
    action: `members.${kind}.delete`,
    summary: `Removed member ${kind} "${row.name}" from the registration list`,
    entity: kind === "location" ? "MemberLocation" : "MemberDepartment",
    entityId: id,
  });
  revalidatePath("/admin/members");
  return { ok: true, message: `"${row.name}" removed. Members that used it keep it on their record.` };
}

export async function deleteMemberLocation(_p: ActionState, f: FormData): Promise<ActionState> {
  return deleteRegRow("location", f);
}
export async function deleteMemberDepartment(_p: ActionState, f: FormData): Promise<ActionState> {
  return deleteRegRow("department", f);
}

/* ---------- Bulk import ---------- */

export async function importMembers(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditMembers()))
    return { ok: false, message: "You don't have permission to import members." };

  const file = formData.get("file");
  let text = "";
  let source = "pasted";
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_UPLOAD_BYTES)
      return { ok: false, message: "That file is over 3.5MB. Split it and import in parts." };
    text = await file.text();
    source = file.name.slice(0, 120) || "upload";
  } else {
    text = String(formData.get("pasted") ?? "");
    if (text.length > MAX_UPLOAD_BYTES)
      return { ok: false, message: "Pasted content is too large. Import in parts." };
  }
  if (!text.trim())
    return { ok: false, message: "Upload a CSV file or paste rows (header must include name and email)." };

  const statuses = await prisma.memberStatus.findMany();
  const defaultStatus = statuses.find((s) => s.isDefault)?.name ?? "Active";
  const parsed = parseMemberRows(text, statuses.map((s) => s.name), defaultStatus);
  if (parsed.rows.length === 0) {
    const why = parsed.warnings[0] ?? parsed.skipped.slice(0, 3).map((s) => `line ${s.line}: ${s.reason}`).join("; ");
    return { ok: false, message: why || "No importable rows found." };
  }

  // Existing emails (chunked lookup): createMany(skipDuplicates) is the
  // real guard; this is for honest reporting.
  const emails = parsed.rows.map((r) => r.email);
  const existing = new Set<string>();
  for (let i = 0; i < emails.length; i += 500) {
    const found = await prisma.member.findMany({
      where: { email: { in: emails.slice(i, i + 500) } },
      select: { email: true },
    });
    for (const f of found) existing.add(f.email);
  }

  const result = await prisma.member.createMany({
    data: parsed.rows,
    skipDuplicates: true,
  });

  const dupes = existing.size + (parsed.rows.length - existing.size - result.count);
  await audit({
    action: "members.import",
    summary: `Bulk member import from ${source}: ${result.count} imported, ${dupes} already existed, ${parsed.skipped.length} skipped`,
    entity: "Member",
    detail: {
      source,
      imported: result.count,
      duplicates: dupes,
      skipped: parsed.skipped.slice(0, 20),
      warnings: parsed.warnings,
    },
  });
  revalidatePath("/admin/members");

  const parts = [`${result.count} imported`];
  if (dupes > 0) parts.push(`${dupes} already existed`);
  if (parsed.skipped.length > 0) {
    const sample = parsed.skipped.slice(0, 3).map((s) => `line ${s.line}: ${s.reason}`).join("; ");
    parts.push(`${parsed.skipped.length} skipped (${sample}${parsed.skipped.length > 3 ? "…" : ""})`);
  }
  return {
    ok: true,
    message: `${parts.join(" · ")}.${parsed.warnings.length ? ` ${parsed.warnings.join(" ")}` : ""}`,
  };
}
