import { NextResponse } from "next/server";
import { denyUnlessCron } from "../_guard";
import { runSftpFetch } from "@/lib/ingest";

// Scheduled by Vercel Cron (see vercel.json). Vercel attaches
// `Authorization: Bearer $CRON_SECRET` to cron invocations; we reject anything
// that doesn't match, and refuse entirely if no secret is configured so the
// endpoint can never be triggered anonymously.
export const dynamic = "force-dynamic";
// Pro allows up to 300s; a vendor drop can be large.
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = denyUnlessCron(request);
  if (denied) return denied;

  const summary = await runSftpFetch("cron");
  return NextResponse.json({ ok: summary.status !== "error", summary });
}
