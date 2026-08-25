// Fixed-window rate limiter backed by Postgres (IM8: application security).
//
// Serverless instances share no memory, so the window lives in the database:
// one row per (key, window start), incremented atomically with an upsert. At
// this system's traffic (a staff console and one portal consumer) the extra
// write per checked request is noise; the alternative, per-instance memory,
// resets on every cold start and undercounts by the instance fan-out.
//
// FAIL-OPEN by design: if the database is unreachable the request proceeds,
// because the same outage already breaks the page the request was for, and a
// closed limiter would turn every database blip into a full lockout.
import { prisma } from "@/lib/db";

/** True = allowed. `limit` requests per `windowSeconds` for this key. */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const windowAt = new Date(
      Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000,
    );
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO "RateWindow" ("key", "windowAt", "count")
      VALUES (${key}, ${windowAt}, 1)
      ON CONFLICT ("key", "windowAt")
      DO UPDATE SET "count" = "RateWindow"."count" + 1
      RETURNING "count"`;
    // Opportunistic pruning, roughly once per fifty checks.
    if (Math.random() < 0.02) {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await prisma.rateWindow.deleteMany({ where: { windowAt: { lt: cutoff } } }).catch(() => {});
    }
    return (rows[0]?.count ?? 0) <= limit;
  } catch (e) {
    console.error("[rate-limit-unavailable]", key, e instanceof Error ? e.message : e);
    return true;
  }
}
