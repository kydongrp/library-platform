import { cookies } from "next/headers";
import { prisma } from "@/lib/db";

// "Act as" session for the Admin Panel, mirroring the learner pattern.
// Real deployments swap this for Azure AD; the authorisation matrix below
// stays the same either way.
const COOKIE = "athenaeum_admin";

export { ADMIN_AREAS, AREA_LABELS, type AdminArea } from "@/lib/admin-areas";

export type AdminSession = {
  id: string;
  name: string;
  email: string;
  groupName: string;
  permissions: Map<string, { canView: boolean; canEdit: boolean }>;
};

export async function getCurrentAdmin(): Promise<AdminSession | null> {
  const store = await cookies();
  const id = store.get(COOKIE)?.value;
  if (!id) return null;
  const user = await prisma.adminUser.findUnique({
    where: { id },
    include: { group: { include: { permissions: true } } },
  });
  if (!user || user.status !== "ACTIVE") return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    groupName: user.group.name,
    permissions: new Map(
      user.group.permissions.map((p) => [
        p.area,
        { canView: p.canView, canEdit: p.canEdit },
      ]),
    ),
  };
}

export function canView(session: AdminSession | null, area: string): boolean {
  return session?.permissions.get(area)?.canView ?? false;
}

export function canEdit(session: AdminSession | null, area: string): boolean {
  return session?.permissions.get(area)?.canEdit ?? false;
}

export async function setCurrentAdmin(id: string) {
  const store = await cookies();
  store.set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearCurrentAdmin() {
  const store = await cookies();
  store.delete(COOKIE);
}
