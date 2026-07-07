"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";

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
  const data = parseMemberForm(formData);
  if (!data.name) return { ok: false, message: "Name is required." };
  if (!data.email) return { ok: false, message: "Email is required." };

  const existing = await prisma.member.findUnique({ where: { email: data.email } });
  if (existing) return { ok: false, message: "A member with that email already exists." };

  const member = await prisma.member.create({ data });
  revalidatePath("/admin/members");
  redirect(`/admin/members/${member.id}`);
}

export async function updateMember(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "");
  const data = parseMemberForm(formData);
  if (!id) return { ok: false, message: "Missing member id." };
  if (!data.name || !data.email)
    return { ok: false, message: "Name and email are required." };

  const clash = await prisma.member.findFirst({
    where: { email: data.email, NOT: { id } },
  });
  if (clash) return { ok: false, message: "Another member already uses that email." };

  await prisma.member.update({ where: { id }, data });
  revalidatePath(`/admin/members/${id}`);
  revalidatePath("/admin/members");
  return { ok: true, message: "Saved." };
}
