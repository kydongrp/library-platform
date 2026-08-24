/**
 * Ask the database which Neon project it actually lives in.
 *
 * Why this exists: on 23 Aug 2026 a Neon "Scale" upgrade was applied to the
 * only Neon organisation we could see in the console, and it turned out that
 * organisation does not own this database at all. Project names, console tabs
 * and Vercel storage entries all lied by omission; the running Postgres did
 * not. Neon publishes its own identifiers as GUCs, so the authoritative answer
 * is one query away and cannot be confused by a similarly-named project.
 *
 * All values here are identifiers, not credentials, so they are safe to print.
 */

import { Client } from "pg";
import { connectionString } from "./dump";

export type NeonIdentity = {
  projectId: string;
  branchId: string;
  endpointId: string;
  /** Endpoint hostname, from the connection string. */
  host: string;
  serverVersion: string;
};

/** GUCs Neon sets on every compute. Absent on non-Neon Postgres. */
const GUCS = ["neon.project_id", "neon.branch_id", "neon.endpoint_id"] as const;

export async function neonIdentity(url = connectionString()): Promise<NeonIdentity> {
  const client = new Client({ connectionString: url });
  // An unhandled 'error' event on a pg Client is fatal to the process and hides
  // whatever actually went wrong; see the restore path for the same guard.
  client.on("error", () => {});
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string; setting: string }>(
      `SELECT name, setting FROM pg_settings WHERE name = ANY($1::text[])`,
      [GUCS as unknown as string[]],
    );
    const got = new Map(rows.map((r) => [r.name, r.setting]));
    const missing = GUCS.filter((g) => !got.get(g));
    if (missing.length) {
      throw new Error(
        `This does not look like a Neon database: missing ${missing.join(", ")}. ` +
          `Host: ${new URL(url).hostname}`,
      );
    }
    const version = await client.query<{ server_version: string }>("SHOW server_version");
    return {
      projectId: got.get("neon.project_id")!,
      branchId: got.get("neon.branch_id")!,
      endpointId: got.get("neon.endpoint_id")!,
      host: new URL(url).hostname,
      serverVersion: version.rows[0].server_version,
    };
  } finally {
    await client.end().catch(() => {});
  }
}
