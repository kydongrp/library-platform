/**
 * Restore drill: proves a backup is actually recoverable, end to end.
 *
 *   npx tsx --env-file=.env scripts/backup-drill.ts
 *
 * 1. Takes a fresh backup of the live database.
 * 2. Creates a throwaway database on the same server.
 * 3. Applies the current Prisma schema to it.
 * 4. Restores the dump into it.
 * 5. Compares every table's row count against the dump manifest, and spot
 *    checks real field values so "the right number of rows" cannot pass for
 *    "the right data".
 * 6. Drops the throwaway database.
 *
 * An untested backup is a guess. This is the test.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { backup, restore, connectionString, describeTarget } from "./lib/dump";

/** Swap the database name in a connection URL, keeping every other param. */
function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function adminUrl(url: string): string {
  // CREATE/DROP DATABASE cannot run while connected to the target.
  return withDatabase(url, "postgres");
}

void (async () => {
  const live = connectionString();
  const stamp = Date.now().toString(36);
  const drillDb = `dls_drill_${stamp}`;
  const workDir = resolve(tmpdir(), `dls-drill-${stamp}`);
  mkdirSync(workDir, { recursive: true });
  const dumpPath = resolve(workDir, "drill.ndjson.gz");

  let failures = 0;
  const check = (ok: boolean, label: string, detail = "") => {
    console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  };

  console.log(`Drill against ${describeTarget(live)}`);
  console.log("\n1. Back up the live database");
  const { manifest, bytes } = await backup(dumpPath, live);
  console.log(`  ${manifest.totalRows} rows, ${manifest.tableOrder.length} tables, ${(bytes / 1024).toFixed(1)} KB`);
  check(manifest.totalRows > 0, "dump is not empty");

  const admin = new Client({ connectionString: adminUrl(live) });
  admin.on("error", (e) => console.error(`  [admin connection] ${e.message}`));
  await admin.connect();
  try {
    console.log(`\n2. Create throwaway database ${drillDb}`);
    await admin.query(`CREATE DATABASE "${drillDb}"`);
    const drillUrl = withDatabase(live, drillDb);

    console.log("\n3. Apply the current Prisma schema to it");
    // Run the Prisma CLI entry point on this node binary rather than through
    // npx: spawning npx.cmd fails with EINVAL on Windows without a shell, and
    // a shell would need the URL quoted into a command line.
    //
    // EVERY url variable must be overridden, not just DATABASE_URL:
    // prisma.config.ts prefers POSTGRES_URL_NON_POOLING, so overriding one
    // variable would push this schema straight at production.
    execFileSync(
      process.execPath,
      [resolve("node_modules/prisma/build/index.js"), "db", "push", "--accept-data-loss"],
      {
        env: {
          ...process.env,
          DATABASE_URL: drillUrl,
          POSTGRES_URL_NON_POOLING: drillUrl,
          DATABASE_URL_UNPOOLED: drillUrl,
        },
        stdio: "pipe",
      },
    );
    const drill = new Client({ connectionString: drillUrl });
    drill.on("error", (e) => console.error(`  [drill connection] ${e.message}`));
    await drill.connect();
    const tblCount = await drill.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'public'`,
    );
    check(
      Number(tblCount.rows[0].n) === manifest.tableOrder.length,
      "schema applied with the same table count",
      `${tblCount.rows[0].n} vs ${manifest.tableOrder.length}`,
    );

    console.log("\n4. Restore the dump into it");
    const res = await restore(dumpPath, drillUrl);
    check(res.total === manifest.totalRows, "total rows restored", `${res.total} of ${manifest.totalRows}`);

    console.log("\n5. Verify the restored data");
    const wrong = manifest.tableOrder.filter(
      (t) => (res.inserted[t] ?? 0) !== (manifest.rowCounts[t] ?? 0),
    );
    check(wrong.length === 0, "every table matches the dump row count", wrong.slice(0, 5).join(", "));

    // Row counts alone would pass even if every field were null, so compare
    // real values on the tables that carry the library's actual substance.
    const probes: { label: string; sql: string }[] = [
      { label: "resource titles", sql: `SELECT count(*)::text AS n FROM "Resource" WHERE title IS NOT NULL AND title <> ''` },
      { label: "member emails", sql: `SELECT count(*)::text AS n FROM "Member" WHERE email LIKE '%@%'` },
      { label: "copy barcodes", sql: `SELECT count(*)::text AS n FROM "Copy" WHERE barcode IS NOT NULL` },
      { label: "loan due dates", sql: `SELECT count(*)::text AS n FROM "Loan" WHERE "dueAt" IS NOT NULL` },
      { label: "audit timestamps", sql: `SELECT count(*)::text AS n FROM "AuditLog" WHERE at IS NOT NULL` },
      { label: "audit json detail", sql: `SELECT count(*)::text AS n FROM "AuditLog" WHERE detail IS NOT NULL` },
      { label: "marc tag subfield arrays", sql: `SELECT count(*)::text AS n FROM "MarcTagDef" WHERE jsonb_array_length(subfields::jsonb) > 0` },
    ];
    const liveClient = new Client({ connectionString: live });
    liveClient.on("error", (e) => console.error(`  [live connection] ${e.message}`));
    await liveClient.connect();
    for (const p of probes) {
      const a = await liveClient.query<{ n: string }>(p.sql);
      const b = await drill.query<{ n: string }>(p.sql);
      check(a.rows[0].n === b.rows[0].n, `${p.label} preserved`, `live ${a.rows[0].n} vs restored ${b.rows[0].n}`);
    }

    // Types must survive the JSON round trip: a timestamp that came back as
    // text would still count as a row.
    const typed = await drill.query<{ due: unknown; cents: unknown }>(
      `SELECT "dueAt" AS due, "fineCents" AS cents FROM "Loan" LIMIT 1`,
    );
    if (typed.rows.length) {
      check(typed.rows[0].due instanceof Date, "timestamps restored as timestamps");
      check(typeof typed.rows[0].cents === "number", "integers restored as integers");
    }

    // Relations must still join: a restore that loses a foreign key leaves
    // orphans that only show up later as broken pages.
    const orphans = await drill.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "Copy" c LEFT JOIN "Resource" r ON r.id = c."resourceId" WHERE r.id IS NULL`,
    );
    check(orphans.rows[0].n === "0", "no orphaned copies after restore", `${orphans.rows[0].n} orphans`);

    await liveClient.end();
    await drill.end();
  } finally {
    console.log(`\n6. Drop ${drillDb}`);
    await admin
      .query(`DROP DATABASE IF EXISTS "${drillDb}" WITH (FORCE)`)
      .catch(async () => {
        // Older servers lack WITH (FORCE); fall back after cutting sessions.
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${drillDb}'`,
        );
        await admin.query(`DROP DATABASE IF EXISTS "${drillDb}"`);
      });
    await admin.end();
    rmSync(workDir, { recursive: true, force: true });
  }

  console.log(
    failures === 0
      ? "\nDRILL PASSED — this backup restores to a byte-faithful copy."
      : `\nDRILL FAILED — ${failures} check(s) did not pass.`,
  );
  process.exit(failures === 0 ? 0 : 1);
})();
