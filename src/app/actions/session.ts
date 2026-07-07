"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { setCurrentMember, clearCurrentMember } from "@/lib/session";

export async function signInAs(formData: FormData): Promise<void> {
  const memberId = String(formData.get("memberId") ?? "");
  if (!memberId) return;
  await setCurrentMember(memberId);
  revalidatePath("/portal", "layout");
  redirect("/portal");
}

export async function signOut(): Promise<void> {
  await clearCurrentMember();
  revalidatePath("/portal", "layout");
  redirect("/portal/signin");
}
