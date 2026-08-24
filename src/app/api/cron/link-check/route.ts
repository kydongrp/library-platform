import { NextResponse } from "next/server";
import { runLinkCheckCore } from "@/lib/linkcheck";
import { audit } from "@/lib/audit";
import { denyUnlessCron } from "../_guard";

/**
 * Nightly access-health scan, scheduled by Vercel Cron (see vercel.json).
 *
 * Renewal alerts and the serial claim sweep used to piggyback this route
 * because the Hobby plan capped the project at two cron jobs. They now have
 * their own schedules (/api/cron/renewal-alerts, /api/cron/serial-claims),
 * so this route does one thing and a slow scan cannot starve the others.
 *
 * Auth: requires the CRON_SECRET bearer token, and refuses entirely when no
 * secret is configured.
 */
export const dynamic = "force-dynamic";
// Link checking makes one network request per access URL, so it is the job
// most likely to need the time. Pro allows up to 300s.
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = denyUnlessCron(request);
  if (denied) return denied;

  const result = await runLinkCheckCore("cron");
  await audit({
    actor: { name: "cron" },
    action: "batch.linkcheck",
    summary: `Scheduled access scan: ${result.summary}`,
    entity: "BatchRun",
  });
  return NextResponse.json({ ok: true, ...result });
}
