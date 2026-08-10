import { NextResponse } from "next/server";
import { runSftpFetch } from "@/lib/ingest";

// Scheduled by Vercel Cron (see vercel.json). Vercel attaches
// `Authorization: Bearer $CRON_SECRET` to cron invocations; we reject anything
// that doesn't match, and refuse entirely if no secret is configured so the
// endpoint can never be triggered anonymously.
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

  const summary = await runSftpFetch("cron");
  return NextResponse.json({ ok: summary.status !== "error", summary });
}
