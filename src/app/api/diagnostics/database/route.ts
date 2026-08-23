import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { denyUnlessCron } from "../../cron/_guard";

/**
 * Reports, from inside the deployed function, which database it is talking to.
 *
 * This exists because of a specific failure: for weeks the Neon console showed
 * projects that looked like this system's database and were not, and nothing
 * could contradict it. The only claim that cannot be argued with comes from the
 * running Postgres itself, and the only place worth asking from is the deployed
 * application — checking locally proves what `.env` says, not what production
 * does.
 *
 * It also answers the two questions a repoint gets wrong quietly:
 *   - pooled vs direct: swapping DATABASE_URL and POSTGRES_URL_NON_POOLING
 *     works fine in a smoke test and exhausts connections under load
 *   - whether the data arrived: a row count, so "it connected" is not mistaken
 *     for "it connected to the right one"
 *
 * Auth: the same fail-closed bearer token as the cron routes. It reveals
 * infrastructure identifiers, so it is not public, but it holds no credentials.
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     https://library.zillearn.com/api/diagnostics/database
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Setting = { name: string; setting: string };

export async function GET(request: Request) {
  const denied = denyUnlessCron(request);
  if (denied) return denied;

  // Neon publishes its own identifiers as GUCs on every compute.
  const settings = await prisma.$queryRaw<Setting[]>`
    SELECT name, setting FROM pg_settings
     WHERE name IN ('neon.project_id', 'neon.branch_id', 'neon.endpoint_id')
  `;
  const neon = Object.fromEntries(
    settings.map((s) => [s.name.replace("neon.", ""), s.setting]),
  ) as Record<string, string | undefined>;

  const [meta] = await prisma.$queryRaw<
    { database: string; version: string; server_addr: string | null }[]
  >`SELECT current_database() AS database, version() AS version, inet_server_addr()::text AS server_addr`;

  const resources = await prisma.resource.count();
  const members = await prisma.member.count();

  // Read the host out of the runtime connection string. The password is never
  // touched; an unparseable value is reported as such rather than echoed.
  let host = "(unparseable)";
  try {
    host = new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    /* leave the placeholder */
  }

  return NextResponse.json({
    ok: true,
    neon: {
      projectId: neon.project_id ?? null,
      branchId: neon.branch_id ?? null,
      endpointId: neon.endpoint_id ?? null,
    },
    connection: {
      host,
      // A pooled host is required at runtime; the direct one runs out of
      // connections once more than a handful of functions are warm.
      pooled: host.includes("-pooler"),
      database: meta?.database ?? null,
      serverAddr: meta?.server_addr ?? null,
    },
    postgres: meta?.version?.split(" ").slice(0, 2).join(" ") ?? null,
    region: process.env.VERCEL_REGION ?? null,
    counts: { resources, members },
  });
}
