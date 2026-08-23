import { NextResponse } from "next/server";

/**
 * Shared bearer-token guard for the scheduled jobs.
 *
 * Fail-closed by design: with no CRON_SECRET configured the endpoint refuses
 * outright rather than running anonymously, because these routes mutate data
 * and send mail.
 *
 * Returns a response to send back, or null when the caller is authorised.
 */
export function denyUnlessCron(request: Request): NextResponse | null {
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
  return null;
}
