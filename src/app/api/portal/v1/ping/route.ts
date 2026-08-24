import { NextResponse } from "next/server";
import { authenticatePortalRequest } from "@/lib/portal-auth";

// GET /api/portal/v1/ping: credential check for integrators.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authenticatePortalRequest(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({
    data: { pong: true, client: auth.client.name, serverTime: new Date().toISOString() },
  });
}
