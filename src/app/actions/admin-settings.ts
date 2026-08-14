"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import {
  ADMIN_AREAS,
  getCurrentAdmin,
  canEdit,
  setCurrentAdmin,
  clearCurrentAdmin,
} from "@/lib/admin-session";
import { audit } from "@/lib/audit";

/* ---------- Act-as session ---------- */

export async function signInAsAdmin(formData: FormData): Promise<void> {
  const id = String(formData.get("adminId") ?? "");
  if (!id) return;
  await setCurrentAdmin(id);
  const user = await prisma.adminUser.findUnique({ where: { id }, select: { name: true } });
  await audit({
    action: "auth.signIn",
    summary: `${user?.name ?? id} signed in`,
    entity: "AdminUser",
    entityId: id,
    actor: { name: user?.name ?? id, id },
  });
  revalidatePath("/admin", "layout");
  redirect("/admin");
}

export async function signOutAdmin(): Promise<void> {
  const admin = await getCurrentAdmin();
  await clearCurrentAdmin();
  if (admin)
    await audit({
      action: "auth.signOut",
      summary: `${admin.name} signed out`,
      entity: "AdminUser",
      entityId: admin.id,
      actor: { name: admin.name, id: admin.id },
    });
  revalidatePath("/admin", "layout");
  redirect("/admin/signin");
}

/* ---------- Groups & access matrix ---------- */

async function requireAdminEdit(): Promise<ActionState | null> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "ADMIN"))
    return { ok: false, message: "You don't have permission to manage admin settings." };
  return null;
}

export async function createGroup(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const denied = await requireAdminEdit();
  if (denied) return denied;

  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  if (!name) return { ok: false, message: "Group name is required." };

  const existing = await prisma.adminGroup.findUnique({ where: { name } });
  if (existing) return { ok: false, message: "A group with that name already exists." };

  await prisma.adminGroup.create({
    data: {
      name,
      description,
      permissions: {
        create: ADMIN_AREAS.map((area) => ({ area, canView: false, canEdit: false })),
      },
    },
  });
  await audit({ action: "settings.group.create", summary: `Created admin group "${name}"`, entity: "AdminGroup", detail: { name, description } });
  revalidatePath("/admin/settings");
  return { ok: true, message: `Group "${name}" created.` };
}

/** Save the full view/edit matrix for one group from checkbox form data. */
export async function updateGroupMatrix(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const denied = await requireAdminEdit();
  if (denied) return denied;

  const groupId = String(formData.get("groupId") ?? "");
  const group = await prisma.adminGroup.findUnique({ where: { id: groupId } });
  if (!group) return { ok: false, message: "Group not found." };

  for (const area of ADMIN_AREAS) {
    const canView = formData.get(`view_${area}`) === "on";
    const canEdit = formData.get(`edit_${area}`) === "on";
    await prisma.adminGroupPermission.upsert({
      where: { groupId_area: { groupId, area } },
      // Edit implies view — a matrix row can't be editable but invisible.
      update: { canView: canView || canEdit, canEdit },
      create: { groupId, area, canView: canView || canEdit, canEdit },
    });
  }
  await audit({ action: "settings.group.matrix", summary: `Saved access matrix for group "${group.name}"`, entity: "AdminGroup", entityId: groupId });
  revalidatePath("/admin/settings");
  revalidatePath("/admin", "layout");
  return { ok: true, message: `Access matrix for "${group.name}" saved.` };
}

export async function deleteGroup(formData: FormData): Promise<void> {
  const denied = await requireAdminEdit();
  if (denied) return;
  const id = String(formData.get("id") ?? "");
  const users = await prisma.adminUser.count({ where: { groupId: id } });
  if (users > 0) return; // guarded in UI; groups with users can't be deleted
  const group = await prisma.adminGroup.delete({ where: { id } });
  await audit({ action: "settings.group.delete", summary: `Deleted admin group "${group.name}"`, entity: "AdminGroup", entityId: id });
  revalidatePath("/admin/settings");
}

/* ---------- Admin users ---------- */

export async function createAdminUser(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const denied = await requireAdminEdit();
  if (denied) return denied;

  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const groupId = String(formData.get("groupId") ?? "");
  if (!name || !email || !groupId)
    return { ok: false, message: "Name, email, and group are required." };

  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) return { ok: false, message: "An admin with that email already exists." };

  const created = await prisma.adminUser.create({ data: { name, email, groupId } });
  await audit({ action: "settings.user.create", summary: `Created admin user "${name}" <${email}>`, entity: "AdminUser", entityId: created.id });
  revalidatePath("/admin/settings");
  return { ok: true, message: `Admin "${name}" created.` };
}

export async function updateAdminUser(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const denied = await requireAdminEdit();
  if (denied) return denied;

  const id = String(formData.get("id") ?? "");
  const groupId = String(formData.get("groupId") ?? "");
  const status = String(formData.get("status") ?? "ACTIVE");

  const self = await getCurrentAdmin();
  if (self?.id === id && status === "SUSPENDED")
    return { ok: false, message: "You can't suspend your own account." };

  const before = await prisma.adminUser.findUnique({ where: { id }, select: { name: true, groupId: true, status: true } });
  await prisma.adminUser.update({ where: { id }, data: { groupId, status } });
  await audit({ action: "settings.user.update", summary: `Updated admin user "${before?.name ?? id}" (group/status)`, entity: "AdminUser", entityId: id, detail: { before, after: { groupId, status } } });
  revalidatePath("/admin/settings");
  revalidatePath("/admin", "layout");
  return { ok: true, message: "Admin updated." };
}

/* ---------- Loan policies ---------- */

export async function updatePolicy(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "POLICIES"))
    return { ok: false, message: "You don't have permission to edit loan policies." };

  const memberType = String(formData.get("memberType") ?? "");
  const int = (name: string, fallback: number) => {
    const v = parseInt(String(formData.get(name) ?? ""), 10);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };

  await prisma.loanPolicy.upsert({
    where: { memberType },
    update: {
      loanDays: int("loanDays", 14),
      maxLoans: int("maxLoans", 5),
      maxRenewals: int("maxRenewals", 2),
      renewalDays: int("renewalDays", 14),
      digitalDays: int("digitalDays", 14),
      holdPickupDays: int("holdPickupDays", 3),
    },
    create: {
      memberType,
      loanDays: int("loanDays", 14),
      maxLoans: int("maxLoans", 5),
      maxRenewals: int("maxRenewals", 2),
      renewalDays: int("renewalDays", 14),
      digitalDays: int("digitalDays", 14),
      holdPickupDays: int("holdPickupDays", 3),
    },
  });
  await audit({ action: "policies.update", summary: `Saved loan policy for ${memberType}`, entity: "LoanPolicy", entityId: memberType });
  revalidatePath("/admin/policies");
  return { ok: true, message: `Policy for ${memberType} saved.` };
}

/* ---------- Email templates ---------- */

export async function updateTemplate(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "TEMPLATES"))
    return { ok: false, message: "You don't have permission to edit templates." };

  const code = String(formData.get("code") ?? "");
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!subject || !body) return { ok: false, message: "Subject and body are required." };

  await prisma.emailTemplate.update({
    where: { code },
    data: {
      subject,
      body,
      inAppEnabled: formData.get("inAppEnabled") === "on",
      emailEnabled: formData.get("emailEnabled") === "on",
    },
  });
  await audit({ action: "templates.update", summary: `Edited email template ${code}`, entity: "EmailTemplate", entityId: code });
  revalidatePath("/admin/templates");
  return { ok: true, message: "Template saved." };
}
