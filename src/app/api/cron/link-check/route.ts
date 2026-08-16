import { NextResponse } from "next/server";
import { runLinkCheckCore } from "@/lib/linkcheck";
import { checkRenewalAlerts } from "@/lib/eresources";
import { audit } from "@/lib/audit";

// Nightly access-health scan, scheduled by Vercel Cron (see vercel.json).
// Subscription renewal alerts piggyback this job — the Hobby cron quota is
// full at 2/2, and nightly is the right cadence for both.
// Same auth model as the SFTP cron: requires the CRON_SECRET bearer token and
// refuses entirely when no secret is configured.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not configured." },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const result = await runLinkCheckCore("cron");
  await audit({
    actor: { name: "cron" },
    action: "batch.linkcheck",
    summary: `Scheduled access scan — ${result.summary}`,
    entity: "BatchRun",
  });

  // Renewal alerts never block the scan result — a bad subscription row must
  // not take down access monitoring.
  let renewals = { checked: 0, due: 0, queued: 0 };
  try {
    renewals = await checkRenewalAlerts();
    if (renewals.queued > 0) {
      await audit({
        actor: { name: "cron" },
        action: "eresources.renewal.alert",
        summary: `Renewal alerts — ${renewals.due} subscription${renewals.due === 1 ? "" : "s"} due within 30 days, ${renewals.queued} email${renewals.queued === 1 ? "" : "s"} queued`,
        entity: "Subscription",
      });
    }
  } catch (err) {
    console.error("renewal alert check failed", err);
  }

  return NextResponse.json({ ok: true, ...result, renewals });
}
