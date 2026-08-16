import { NextResponse } from "next/server";
import { runLinkCheckCore } from "@/lib/linkcheck";
import { audit } from "@/lib/audit";

// Nightly access-health scan, scheduled by Vercel Cron (see vercel.json).
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
  return NextResponse.json({ ok: true, ...result });
}
