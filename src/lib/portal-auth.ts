// Authentication for the read-only Portal API (/api/portal/v1).
// Keys look like "dls_live_<48 hex chars>"; only the SHA-256 hash is stored,
// so a database leak never leaks credentials. The prefix column exists for
// display ("dls_live_3fa9…") and support conversations. Lookup is by the
// unique hash, not the prefix.

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";

export const KEY_PREFIX = "dls_live_";
const PREFIX_DISPLAY_LEN = KEY_PREFIX.length + 8;
const LAST_USED_BUMP_MS = 60_000;

export function generateApiKey(): { key: string; keyPrefix: string; keyHash: string } {
  const key = KEY_PREFIX + randomBytes(24).toString("hex");
  return { key, keyPrefix: key.slice(0, PREFIX_DISPLAY_LEN), keyHash: hashKey(key) };
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Constant-time hex comparison (both sides are fixed-length sha256 hex). */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export type ApiAuth =
  | { ok: true; client: { id: string; name: string } }
  | { ok: false; response: NextResponse };

export function apiError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

/** Gate a portal route: Authorization: Bearer dls_live_… → ApiClient. */
export async function authenticatePortalRequest(request: Request): Promise<ApiAuth> {
  // The portal is one trusted server-to-server consumer, so the per-address
  // window counts only FAILED authentications: it throttles key guessing
  // without rationing legitimate traffic that all arrives from one egress.
  const ip =
    request.headers.get("x-real-ip") ??
    (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  const authFailLimited = async () =>
    !(await rateLimit(`portal:authfail:${ip}`, 60, 60))
      ? apiError(429, "rate_limited", "Too many failed authentications; retry in a minute.")
      : null;

  const header = request.headers.get("authorization") ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!key.startsWith(KEY_PREFIX)) {
    const limited = await authFailLimited();
    return {
      ok: false,
      response:
        limited ?? apiError(401, "missing_key", "Pass an API key: Authorization: Bearer dls_live_…"),
    };
  }

  const client = await prisma.apiClient.findUnique({ where: { keyHash: hashKey(key) } });
  // findUnique on the hash already proves possession; the timing-safe compare
  // is a belt-and-braces recheck that costs nothing.
  if (!client || !hashesEqual(client.keyHash, hashKey(key))) {
    const limited = await authFailLimited();
    return { ok: false, response: limited ?? apiError(401, "invalid_key", "Unknown API key.") };
  }
  if (client.status !== "ACTIVE") {
    return { ok: false, response: apiError(403, "revoked_key", "This API key has been revoked.") };
  }
  // Sized for the portal backend's fan-out (20 requests/second sustained),
  // a ceiling against runaway loops rather than a ration.
  if (!(await rateLimit(`portal:client:${client.id}`, 1200, 60))) {
    return { ok: false, response: apiError(429, "rate_limited", "Request rate exceeded for this key; retry shortly.") };
  }

  // Bump lastUsedAt at most once a minute: no write amplification per request.
  const now = new Date();
  if (!client.lastUsedAt || now.getTime() - client.lastUsedAt.getTime() > LAST_USED_BUMP_MS) {
    await prisma.apiClient
      .update({ where: { id: client.id }, data: { lastUsedAt: now } })
      .catch(() => {});
  }

  return { ok: true, client: { id: client.id, name: client.name } };
}
