import { cookies } from "next/headers";
import { prisma } from "@/lib/db";

// Lightweight "act as" session for the Learner Portal. A full auth system
// (Azure AD / external sign-up, as in the reference spec) is a future
// enhancement; for now the learner picks which member to act as and we store
// that id in a cookie.
const COOKIE = "athenaeum_member";

export async function getCurrentMember() {
  const store = await cookies();
  const id = store.get(COOKIE)?.value;
  if (!id) return null;
  return prisma.member.findUnique({ where: { id } });
}

export async function setCurrentMember(id: string) {
  const store = await cookies();
  store.set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearCurrentMember() {
  const store = await cookies();
  store.delete(COOKIE);
}
