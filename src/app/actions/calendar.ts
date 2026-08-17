"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit } from "@/lib/audit";
import { CALENDAR_ID } from "@/lib/calendar";
import { parseDateKey, dateKey, WEEKDAY_NAMES } from "@/lib/calendar-core";

// The service calendar is a circulation rule, so it rides the POLICIES area
// (a new RBAC area would leave existing admin groups without permission rows).
async function requireCalendarEditor(): Promise<{ name: string } | null> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "POLICIES")) return null;
  return { name: admin!.name };
}

const NO_PERMISSION = {
  ok: false as const,
  message: "You don't have permission to edit the library calendar.",
};

const clip = (v: FormDataEntryValue | null, n: number) => String(v ?? "").trim().slice(0, n);

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

/** Save which weekdays the library is routinely closed. */
export async function setClosedWeekdays(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCalendarEditor();
  if (!admin) return NO_PERMISSION;

  const days = formData
    .getAll("weekday")
    .map((v) => parseInt(String(v), 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  const unique = [...new Set(days)].sort((a, b) => a - b);
  if (unique.length >= 7)
    return { ok: false, message: "The library can't be closed every day of the week." };

  await prisma.serviceCalendar.upsert({
    where: { id: CALENDAR_ID },
    create: { id: CALENDAR_ID, closedWeekdays: unique },
    update: { closedWeekdays: unique },
  });
  await audit({
    action: "calendar.weekdays",
    summary: `Weekly closures set to ${unique.length ? unique.map((d) => WEEKDAY_NAMES[d]).join(", ") : "none"}`,
    entity: "ServiceCalendar",
  });
  revalidatePath("/admin/calendar");
  return {
    ok: true,
    message: unique.length
      ? `Closed weekly on ${unique.map((d) => WEEKDAY_NAMES[d]).join(", ")}. New loans and renewals use this immediately.`
      : "No weekly closures — the library is open every day.",
  };
}

/** Add a one-off closure (public holiday, stocktake, works). */
export async function addClosure(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCalendarEditor();
  if (!admin) return NO_PERMISSION;

  const raw = clip(formData.get("date"), 10);
  const date = parseDateKey(raw);
  if (!date) return { ok: false, message: "Pick a valid date." };
  const name = clip(formData.get("name"), 120);
  if (!name) return { ok: false, message: "Give the closure a name (e.g. Deepavali)." };

  try {
    await prisma.libraryClosure.create({ data: { date, name, createdBy: admin.name } });
  } catch (e) {
    if (isUniqueViolation(e))
      return { ok: false, message: `${raw} is already marked as a closure.` };
    throw e;
  }
  await audit({
    action: "calendar.closure.add",
    summary: `Marked ${raw} closed: ${name}`,
    entity: "LibraryClosure",
  });
  revalidatePath("/admin/calendar");
  return {
    ok: true,
    message: `${name} on ${raw} added. Existing loans keep their due dates; new loans and renewals skip it.`,
  };
}

export async function deleteClosure(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireCalendarEditor();
  if (!admin) return NO_PERMISSION;

  const id = clip(formData.get("id"), 40);
  const closure = await prisma.libraryClosure.findUnique({ where: { id } });
  if (!closure) return { ok: false, message: "That closure no longer exists." };
  await prisma.libraryClosure.delete({ where: { id } });
  await audit({
    action: "calendar.closure.delete",
    summary: `Removed closure ${dateKey(closure.date)} (${closure.name})`,
    entity: "LibraryClosure",
    entityId: id,
  });
  revalidatePath("/admin/calendar");
  return { ok: true, message: `${closure.name} removed — the library is open that day again.` };
}
