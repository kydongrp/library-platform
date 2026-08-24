import { NextResponse } from "next/server";
import { checkRenewalAlerts } from "@/lib/eresources";
import { audit } from "@/lib/audit";
import { denyUnlessCron } from "../_guard";

/**
 * Subscription renewal alerts, scheduled by Vercel Cron (see vercel.json).
 *
 * This used to piggyback the nightly access scan because the Hobby plan
 * allowed only two cron jobs. On Pro it gets its own schedule and its own
 * time budget, so a slow link scan can no longer starve it.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const denied = denyUnlessCron(request);
  if (denied) return denied;

  const renewals = await checkRenewalAlerts();
  if (renewals.queued > 0) {
    await audit({
      actor: { name: "cron" },
      action: "eresources.renewal.alert",
      summary: `Renewal alerts: ${renewals.due} subscription${renewals.due === 1 ? "" : "s"} due within 30 days, ${renewals.queued} email${renewals.queued === 1 ? "" : "s"} queued`,
      entity: "Subscription",
    });
  }
  return NextResponse.json({ ok: true, renewals });
}
