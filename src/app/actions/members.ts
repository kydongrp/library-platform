"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit } from "@/lib/audit";

// Server actions are directly invocable endpoints — re-check rights here.
async function canEditMembers(): Promise<boolean> {
  return canEdit(await getCurrentAdmin(), "MEMBERS");
}

function defaultMaxLoans(memberType: string): number {
  return memberType === "STAFF" ? 10 : memberType === "EXTERNAL" ? 3 : 5;
}

function parseMemberForm(formData: FormData) {
  const memberType = String(formData.get("memberType") ?? "STUDENT");
  const maxRaw = String(formData.get("maxLoans") ?? "").trim();
  return {
    name: String(formData.get("name") ?? "").trim(),
    email: String(formData.get("email") ?? "").trim().toLowerCase(),
    memberType,
    status: String(formData.get("status") ?? "ACTIVE"),
    maxLoans: maxRaw ? parseInt(maxRaw, 10) : defaultMaxLoans(memberType),
  };
}

export async function createMember(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditMembers()))
    return { ok: false, message: "You don't have permission to manage members." };
  const data = parseMemberForm(formData);
  if (!data.name) return { ok: false, message: "Name is required." };
  if (!data.email) return { ok: false, message: "Email is required." };

  const existing = await prisma.member.findUnique({ where: { email: data.email } });
  if (existing) return { ok: false, message: "A member with that email already exists." };

  const member = await prisma.member.create({ data });
  await audit({
    action: "members.create",
    summary: `Created member "${data.name}" <${data.email}> (${data.memberType})`,
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
  const id = String(formData.get("id") ?? "");
  const data = parseMemberForm(formData);
  if (!id) return { ok: false, message: "Missing member id." };
  if (!data.name || !data.email)
    return { ok: false, message: "Name and email are required." };

  const clash = await prisma.member.findFirst({
    where: { email: data.email, NOT: { id } },
  });
  if (clash) return { ok: false, message: "Another member already uses that email." };

  const before = await prisma.member.findUnique({
    where: { id },
    select: { name: true, email: true, memberType: true, status: true, maxLoans: true },
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
