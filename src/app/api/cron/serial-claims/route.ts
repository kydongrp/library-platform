import { NextResponse } from "next/server";
import { runSerialClaims } from "@/lib/serials";
import { audit } from "@/lib/audit";
import { denyUnlessCron } from "../_guard";

/**
 * Serial missing-issue claim sweep, scheduled by Vercel Cron (see
 * vercel.json). Claims each issue past the grace period once.
 *
 * Previously piggybacked the nightly access scan under the Hobby two-cron
 * limit; on Pro it runs on its own schedule so a slow scan cannot eat its
 * budget and leave vendors unchased.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const denied = denyUnlessCron(request);
  if (denied) return denied;

  const serialClaims = await runSerialClaims();
  if (serialClaims.claimsQueued > 0) {
    await audit({
      actor: { name: "cron" },
      action: "serials.claimSweep",
      summary: `Serial claim sweep — ${serialClaims.late} late issue${serialClaims.late === 1 ? "" : "s"}, ${serialClaims.claimsQueued} claim email${serialClaims.claimsQueued === 1 ? "" : "s"} queued`,
      entity: "SerialIssue",
    });
  }
  return NextResponse.json({ ok: true, serialClaims });
}
