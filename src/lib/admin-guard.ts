import { redirect } from "next/navigation";
import { getCurrentAdmin, canView, type AdminSession } from "@/lib/admin-session";

/**
 * Server-side page guard: redirects to sign-in when no admin session exists,
 * and to the no-access page when the session lacks view rights for the area.
 */
export async function requireAdminView(area: string): Promise<AdminSession> {
  const admin = await getCurrentAdmin();
  if (!admin) redirect("/admin/signin");
  if (!canView(admin, area)) redirect("/admin/no-access");
  return admin;
}
