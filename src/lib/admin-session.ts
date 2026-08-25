import { createHash, randomBytes } from "crypto";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/db";

// Staff session for the Admin Panel. The cookie holds a random 256-bit token;
// only its SHA-256 hash is stored server-side, so neither the cookie value nor
// a database read alone is enough to mint a session for someone else. Real
// deployments layer Azure AD / Microsoft Entra ID sign-in in front of this;
// the authorisation matrix below stays the same either way.
const COOKIE = "athenaeum_admin";
const SESSION_TTL_S = 60 * 60 * 12; // 12 hours, absolute

export { ADMIN_AREAS, AREA_LABELS, type AdminArea } from "@/lib/admin-areas";

export type AdminSession = {
  id: string;
  name: string;
  email: string;
  groupName: string;
  permissions: Map<string, { canView: boolean; canEdit: boolean }>;
};

/**
 * The act-as switcher is an evaluation affordance, not authentication, so in
 * production it must be asked for by name: set ALLOW_EVAL_SIGNIN=1. Removing
 * that variable is the kill switch once Entra ID sign-in lands.
 */
export function evalSignInAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ALLOW_EVAL_SIGNIN === "1";
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Best-effort request metadata; empty outside a request context. */
export async function requestMeta(): Promise<{ ip?: string; userAgent?: string }> {
  try {
    const h = await headers();
    const fwd = h.get("x-forwarded-for");
    return {
      // x-real-ip is set by the platform; the leftmost forwarded hop is
      // client-supplied and spoofable, so it is only the fallback.
      ip: h.get("x-real-ip") ?? (fwd ? fwd.split(",")[0].trim() : undefined),
      userAgent: h.get("user-agent") ?? undefined,
    };
  } catch {
    return {};
  }
}

export async function getCurrentAdmin(): Promise<AdminSession | null> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.adminSessionToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { group: { include: { permissions: true } } } } },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  const user = session.user;
  if (user.status !== "ACTIVE") return null;
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

/**
 * Create a server-side session for an ACTIVE staff account and set the cookie.
 * Returns false without setting anything when the account does not exist or is
 * not ACTIVE: validation happens before the session exists, not after.
 */
export async function createAdminSession(userId: string): Promise<boolean> {
  const user = await prisma.adminUser.findUnique({ where: { id: userId } });
  if (!user || user.status !== "ACTIVE") return false;

  // Replacing a session revokes the one this browser held: switching
  // accounts must not leave the previous token live for its remaining hours.
  const store = await cookies();
  const prior = store.get(COOKIE)?.value;
  if (prior) await revokeByToken(prior);

  const meta = await requestMeta();
  const token = randomBytes(32).toString("hex");
  await prisma.adminSessionToken.create({
    data: {
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + SESSION_TTL_S * 1000),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    },
  });
  // Opportunistic retention: expired and revoked rows have no further use.
  await prisma.adminSessionToken
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch(() => {});

  store.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_S,
  });
  return true;
}

async function revokeByToken(token: string): Promise<void> {
  try {
    await prisma.adminSessionToken.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  } catch (e) {
    // The cookie still gets cleared, but a session row that outlives a
    // sign-out is worth an alertable line, same convention as audit writes.
    console.error("[session-revoke-failed]", e instanceof Error ? e.message : e);
  }
}

/** Revoke the server-side session (immediate, not cookie-expiry dependent) and clear the cookie. */
export async function clearCurrentAdmin() {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (token) await revokeByToken(token);
  store.delete(COOKIE);
}
