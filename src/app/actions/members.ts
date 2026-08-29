"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { listMemberTypes, resolveMemberType } from "@/lib/member-types";
import { hashPassword, checkPassword } from "@/lib/member-password";
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

/** A date-only field from the form, at noon UTC so a zone shift cannot move it a day. */
function parseDateField(raw: FormDataEntryValue | null): Date | null {
  const v = String(raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T12:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function parseMemberForm(formData: FormData) {
  const types = await listMemberTypes();
  const memberType = resolveMemberType(formData.get("memberType"), types);
  const maxRaw = clip(formData.get("maxLoans"), 4);
  const langRaw = clip(formData.get("language"), 20);
  const language =
    (MEMBER_LANGUAGES as readonly string[]).find((l) => l.toLowerCase() === langRaw.toLowerCase()) ??
    "English";

  // The register is filed by family name, so the parts are stored. `name`
  // remains the display field every existing screen, report and export reads,
  // and is derived here rather than being a second thing to keep in step.
  const firstName = clip(formData.get("firstName"), 100);
  const lastName = clip(formData.get("lastName"), 100);
  const composed = [firstName, lastName].filter(Boolean).join(" ").trim();

  return {
    memberNo: clip(formData.get("memberNo"), 40) || null,
    associateId: clip(formData.get("associateId"), 40) || null,
    associateId2: clip(formData.get("associateId2"), 40) || null,
    firstName: firstName || null,
    lastName: lastName || null,
    name: composed || clip(formData.get("name"), 200),
    title: clip(formData.get("title"), 60) || null,
    position: clip(formData.get("position"), 120) || null,
    email: clip(formData.get("email"), 200).toLowerCase(),
    memberType,
    status: await validStatusOrDefault(clip(formData.get("status"), 40)),
    phone: clip(formData.get("phone"), 40) || null,
    language,
    location: clip(formData.get("location"), 120) || null,
    department: clip(formData.get("department"), 120) || null,
    membershipStartAt: parseDateField(formData.get("membershipStartAt")),
    membershipExpiryAt: parseDateField(formData.get("membershipExpiryAt")),
    remark: clip(formData.get("remark"), 2000) || null,
    photoUrl: clip(formData.get("photoUrl"), 500) || null,
    receiveEmailNotices: formData.get("receiveEmailNotices") === "on",
    receiveSms: formData.get("receiveSms") === "on",
    maxLoans: maxRaw ? parseInt(maxRaw, 10) : defaultMaxLoans(memberType),
  };
}

/**
 * Extra phone numbers, emails and addresses, as the repeatable rows the form
 * submits (contactKind[], contactLabel[], contactValue[] and the address
 * equivalents). Rows with no value are dropped rather than stored blank.
 */
function parseContacts(formData: FormData) {
  const kinds = formData.getAll("contactKind").map(String);
  const labels = formData.getAll("contactLabel").map(String);
  const values = formData.getAll("contactValue").map(String);
  const contacts = values
    .map((value, i) => ({
      kind: kinds[i] === "EMAIL" ? "EMAIL" : "PHONE",
      label: (labels[i] ?? "").trim().slice(0, 40) || null,
      value: value.trim().slice(0, 200),
      sortOrder: i,
    }))
    .filter((c) => c.value.length > 0)
    .slice(0, 20);

  const aLabels = formData.getAll("addressLabel").map(String);
  const l1 = formData.getAll("addressLine1").map(String);
  const l2 = formData.getAll("addressLine2").map(String);
  const l3 = formData.getAll("addressLine3").map(String);
  const postals = formData.getAll("addressPostal").map(String);
  const countries = formData.getAll("addressCountry").map(String);
  const addresses = l1
    .map((line1, i) => ({
      label: (aLabels[i] ?? "").trim().slice(0, 40) || null,
      line1: line1.trim().slice(0, 200) || null,
      line2: (l2[i] ?? "").trim().slice(0, 200) || null,
      line3: (l3[i] ?? "").trim().slice(0, 200) || null,
      postal: (postals[i] ?? "").trim().slice(0, 20) || null,
      country: (countries[i] ?? "").trim().slice(0, 80) || null,
      sortOrder: i,
    }))
    .filter((a) => a.line1 || a.line2 || a.line3 || a.postal || a.country)
    .slice(0, 10);

  return { contacts, addresses };
}

/**
 * Resolve the password field into a value for `data`, or a problem to report.
 *
 * Blank means "leave whatever is there", so editing a member without touching
 * the password field cannot silently clear their sign-in.
 */
async function parsePassword(
  formData: FormData,
  context: { email: string; name: string },
): Promise<{ error: string } | { set: false } | { set: true; passwordHash: string; passwordSetAt: Date }> {
  const raw = String(formData.get("password") ?? "");
  if (!raw) return { set: false };
  const problem = checkPassword(raw, context);
  if (problem) return { error: problem };
  return { set: true, passwordHash: await hashPassword(raw), passwordSetAt: new Date() };
}

export async function createMember(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditMembers()))
    return { ok: false, message: "You don't have permission to manage members." };
  const data = await parseMemberForm(formData);
  // Required on the form: member number, last name, status, type and email.
  // Status and type cannot be absent (both resolve to a default), so the three
  // that can actually be missing are checked here.
  if (!data.memberNo) return { ok: false, message: "Member ID is required." };
  if (!data.lastName) return { ok: false, message: "Last name is required." };
  if (!data.email) return { ok: false, message: "Email is required." };

  const existing = await prisma.member.findUnique({ where: { email: data.email } });
  if (existing) return { ok: false, message: "A member with that email already exists." };

  // Member number is indexed rather than unique at the database level, so the
  // check lives here. See the schema comment: a unique constraint would make
  // the build's `prisma db push` demand --accept-data-loss.
  const numberClash = await prisma.member.findFirst({ where: { memberNo: data.memberNo } });
  if (numberClash) {
    return { ok: false, message: `Member ID "${data.memberNo}" is already used by ${numberClash.name}.` };
  }

  const password = await parsePassword(formData, { email: data.email, name: data.name });
  if ("error" in password) return { ok: false, message: password.error };

  const { contacts, addresses } = parseContacts(formData);

  const member = await prisma.member.create({
    data: {
      ...data,
      ...(password.set
        ? { passwordHash: password.passwordHash, passwordSetAt: password.passwordSetAt }
        : {}),
      contacts: { create: contacts },
      addresses: { create: addresses },
    },
  });
  await audit({
    action: "members.create",
    // The password is never echoed, only the fact that one was set.
    summary: `Created member "${data.name}" <${data.email}> (${data.memberType}, ${data.status})`,
    detail: {
      memberNo: data.memberNo,
      contacts: contacts.length,
      addresses: addresses.length,
      portalPasswordSet: password.set,
    },
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
  if (!data.memberNo) return { ok: false, message: "Member ID is required." };
  if (!data.lastName) return { ok: false, message: "Last name is required." };
  if (!data.email) return { ok: false, message: "Email is required." };

  const clash = await prisma.member.findFirst({
    where: { email: data.email, NOT: { id } },
  });
  if (clash) return { ok: false, message: "Another member already uses that email." };

  const numberClash = await prisma.member.findFirst({
    where: { memberNo: data.memberNo, NOT: { id } },
  });
  if (numberClash) {
    return { ok: false, message: `Member ID "${data.memberNo}" is already used by ${numberClash.name}.` };
  }

  const password = await parsePassword(formData, { email: data.email, name: data.name });
  if ("error" in password) return { ok: false, message: password.error };

  const { contacts, addresses } = parseContacts(formData);

  const before = await prisma.member.findUnique({
    where: { id },
    select: {
      name: true, email: true, memberType: true, status: true, maxLoans: true,
      phone: true, language: true, location: true, department: true,
    },
  });
  // Contacts and addresses are replaced wholesale: the form submits the full
  // set every time, so a row the user deleted must disappear rather than
  // linger because nothing referenced it any more.
  await prisma.$transaction(async (tx) => {
    await tx.memberContact.deleteMany({ where: { memberId: id } });
    await tx.memberAddress.deleteMany({ where: { memberId: id } });
    await tx.member.update({
      where: { id },
      data: {
        ...data,
        ...(password.set
          ? { passwordHash: password.passwordHash, passwordSetAt: password.passwordSetAt }
          : {}),
        contacts: { create: contacts },
        addresses: { create: addresses },
      },
    });
  });
  await audit({
    action: "members.update",
    summary: `Updated member "${data.name}"`,
    entity: "Member",
    entityId: id,
    detail: { before, after: data, portalPasswordChanged: password.set },
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
  if (!name) return { ok: false, message: "Give the status a name (e.g. On Secondment)." };
  const suspends = formData.get("suspends") === "on";
  const makeDefault = formData.get("isDefault") === "on";

  // 0 and blank both mean "no automatic lapse". A negative or absurd figure is
  // treated the same way rather than being stored and quietly suspending
  // everybody on the next run.
  const daysRaw = String(formData.get("autoAfterInactiveDays") ?? "").trim();
  const parsedDays = daysRaw ? Number.parseInt(daysRaw, 10) : NaN;
  const autoAfterInactiveDays =
    Number.isFinite(parsedDays) && parsedDays > 0 && parsedDays <= 3650 ? parsedDays : null;

  if (autoAfterInactiveDays !== null && !suspends) {
    return {
      ok: false,
      message: "Only a status that suspends the member can be applied automatically after inactivity.",
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (makeDefault) await tx.memberStatus.updateMany({ data: { isDefault: false } });
      await tx.memberStatus.create({
        data: {
          name,
          suspends,
          autoAfterInactiveDays,
          isDefault: makeDefault,
          note: clip(formData.get("note"), 200) || null,
          // Kept in step for the one release where the deprecated column still
          // exists, so an older running instance does not see a contradiction.
          canBorrow: !suspends,
        },
      });
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, message: `Status "${name}" already exists.` };
    throw e;
  }
  await audit({
    action: "members.status.create",
    summary: `Created member status "${name}"${suspends ? " (suspends the member)" : ""}${autoAfterInactiveDays ? `, applied after ${autoAfterInactiveDays} days inactive` : ""}${makeDefault ? ", default" : ""}`,
    entity: "MemberStatus",
  });
  revalidatePath("/admin/members");
  return { ok: true, message: `Status "${name}" added.` };
}

/**
 * Set how many days of inactivity apply this status automatically.
 *
 * Replaces the old borrowing toggle. Blank or 0 switches the rule off, which is
 * the only way to stop it: a library that has not chosen a period must not have
 * one chosen for it.
 */
export async function setStatusLapseRule(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditMembers()))
    return { ok: false, message: "You don't have permission to manage member statuses." };
  const id = clip(formData.get("id"), 40);
  const s = await prisma.memberStatus.findUnique({ where: { id } });
  if (!s) return { ok: false, message: "That status no longer exists." };
  if (!s.suspends) {
    return {
      ok: false,
      message: `"${s.name}" does not suspend the member, so it cannot be applied automatically.`,
    };
  }

  const raw = String(formData.get("days") ?? "").trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const days = Number.isFinite(parsed) && parsed > 0 && parsed <= 3650 ? parsed : null;

  await prisma.memberStatus.update({ where: { id }, data: { autoAfterInactiveDays: days } });
  await audit({
    action: "members.status.lapseRule",
    summary: days
      ? `Status "${s.name}" applies automatically after ${days} days of inactivity`
      : `Status "${s.name}" is no longer applied automatically`,
    entity: "MemberStatus",
    entityId: id,
    detail: { days },
  });
  revalidatePath("/admin/members");
  return {
    ok: true,
    message: days
      ? `Members inactive for ${days} days will be moved to "${s.name}".`
      : `Automatic ${s.name.toLowerCase()} is switched off.`,
  };
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
