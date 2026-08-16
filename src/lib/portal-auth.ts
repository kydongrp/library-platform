// Authentication for the read-only Portal API (/api/portal/v1).
// Keys look like "dls_live_<48 hex chars>"; only the SHA-256 hash is stored,
// so a database leak never leaks credentials. The prefix column exists for
// display ("dls_live_3fa9…") and support conversations, not for lookup —
// lookup is by unique hash.

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

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
  const header = request.headers.get("authorization") ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!key.startsWith(KEY_PREFIX)) {
    return {
      ok: false,
      response: apiError(401, "missing_key", "Pass an API key: Authorization: Bearer dls_live_…"),
    };
  }

  const client = await prisma.apiClient.findUnique({ where: { keyHash: hashKey(key) } });
  // findUnique on the hash already proves possession; the timing-safe compare
  // is a belt-and-braces recheck that costs nothing.
  if (!client || !hashesEqual(client.keyHash, hashKey(key))) {
    return { ok: false, response: apiError(401, "invalid_key", "Unknown API key.") };
  }
  if (client.status !== "ACTIVE") {
    return { ok: false, response: apiError(403, "revoked_key", "This API key has been revoked.") };
  }

  // Bump lastUsedAt at most once a minute — no write amplification per request.
  const now = new Date();
  if (!client.lastUsedAt || now.getTime() - client.lastUsedAt.getTime() > LAST_USED_BUMP_MS) {
    await prisma.apiClient
      .update({ where: { id: client.id }, data: { lastUsedAt: now } })
      .catch(() => {});
  }

  return { ok: true, client: { id: client.id, name: client.name } };
}
