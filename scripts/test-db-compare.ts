/**
 * Tests the database comparison used to sign off a migration.
 *
 *   npx tsx --env-file=.env scripts/test-db-compare.ts
 *
 * A verifier that always says "identical" is worse than no verifier, because it
 * launders a bad migration into a signed-off one. So this builds a real copy of
 * the live database on a throwaway database, proves the comparison passes, then
 * damages the copy one way at a time and proves the comparison catches each
 * kind of damage:
 *
 *   - a single changed character in one text field
 *   - a NULLed column value
 *   - a deleted row
 *   - a dropped unique index
 *   - a dropped foreign key
 *   - a widened column type
 *
 * Read-only against the live database; every write lands on the throwaway.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { backup, restore, connectionString, describeTarget } from "./lib/dump";
import { compareDatabases } from "./lib/db-compare";

function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

void (async () => {
  const live = connectionString();
  const stamp = Date.now().toString(36);
  const copyDb = `dls_cmp_${stamp}`;
  const workDir = resolve(tmpdir(), `dls-cmp-${stamp}`);
  mkdirSync(workDir, { recursive: true });
  const dumpPath = resolve(workDir, "cmp.ndjson.gz");

  console.log(`Comparison tests against ${describeTarget(live)}`);

  const admin = new Client({ connectionString: withDatabase(live, "postgres") });
  admin.on("error", () => {});
  await admin.connect();

  try {
    const { manifest } = await backup(dumpPath, live);
    await admin.query(`CREATE DATABASE "${copyDb}"`);
    const copyUrl = withDatabase(live, copyDb);
    execFileSync(
      process.execPath,
      [resolve("node_modules/prisma/build/index.js"), "db", "push", "--accept-data-loss"],
      {
        env: {
          ...process.env,
          DATABASE_URL: copyUrl,
          POSTGRES_URL_NON_POOLING: copyUrl,
          DATABASE_URL_UNPOOLED: copyUrl,
        },
        stdio: "pipe",
      },
    );
    await restore(dumpPath, copyUrl);
    console.log(`Copy built: ${manifest.totalRows} rows, ${manifest.tableOrder.length} tables\n`);

    const blockingCount = async () => {
      const r = await compareDatabases({ label: "live", url: live }, { label: "copy", url: copyUrl });
      return {
        blocking: r.differences.filter((d) => d.blocking),
        digests: r.digestsCompared,
      };
    };

    console.log("1. A faithful copy compares clean");
    const clean = await blockingCount();
    check(clean.digests, "content digests were actually compared");
    check(
      clean.blocking.length === 0,
      "no blocking differences on a faithful copy",
      clean.blocking.map((d) => `${d.kind}:${d.subject}`).slice(0, 5).join(", "),
    );

    const copy = new Client({ connectionString: copyUrl });
    copy.on("error", () => {});
    await copy.connect();

    // Each case damages the copy in one specific way, asserts the comparison
    // both notices and classifies it, then the copy is rebuilt from the dump.
    const cases: {
      label: string;
      kind: string;
      damage: string;
      skipIf?: string;
    }[] = [
      {
        label: "one changed character in a text field",
        kind: "content",
        damage: `UPDATE "Resource" SET title = title || 'x' WHERE id = (SELECT id FROM "Resource" ORDER BY id LIMIT 1)`,
      },
      {
        label: "a NULLed nullable column",
        kind: "content",
        damage: `UPDATE "Resource" SET description = NULL WHERE id = (SELECT id FROM "Resource" WHERE description IS NOT NULL ORDER BY id LIMIT 1)`,
        skipIf: `SELECT count(*) = 0 AS skip FROM "Resource" WHERE description IS NOT NULL`,
      },
      {
        label: "a deleted row",
        kind: "counts",
        damage: `DELETE FROM "AuditLog" WHERE id = (SELECT id FROM "AuditLog" ORDER BY id LIMIT 1)`,
      },
      {
        label: "a dropped unique index",
        kind: "rules",
        damage: `DROP INDEX IF EXISTS "Copy_barcode_key"`,
      },
      {
        label: "a dropped foreign key",
        kind: "rules",
        damage: `ALTER TABLE "Copy" DROP CONSTRAINT IF EXISTS "Copy_resourceId_fkey"`,
      },
      {
        label: "a widened column type",
        kind: "shape",
        damage: `ALTER TABLE "Resource" ALTER COLUMN "publishedYear" TYPE bigint`,
      },
    ];

    // Rebuilding from the dump after each case is cheaper to reason about than
    // hand-writing an inverse for every kind of damage, and it also re-proves
    // that a fresh restore lands clean.
    let n = 2;
    for (const c of cases) {
      console.log(`\n${n}. Detects ${c.label}`);
      n++;
      if (c.skipIf) {
        const r = await copy.query<{ skip: boolean }>(c.skipIf);
        if (r.rows[0]?.skip) {
          console.log(`  SKIP  no suitable row in this dataset`);
          continue;
        }
      }
      await copy.query(c.damage);
      const after = await blockingCount();
      const kinds = new Set(after.blocking.map((d) => d.kind));
      check(after.blocking.length > 0, `damage was detected`, `${after.blocking.length} blocking difference(s)`);
      check(
        kinds.has(c.kind as never),
        `reported as a "${c.kind}" difference`,
        `got: ${[...kinds].join(", ") || "none"}`,
      );
      // Restore replaces the data; only DDL damage needs the schema re-pushed
      // first, and pushing the schema can itself wipe rows, so restore again.
      await restore(dumpPath, copyUrl);
      if (c.kind === "rules" || c.kind === "shape") {
        execFileSync(
          process.execPath,
          [resolve("node_modules/prisma/build/index.js"), "db", "push", "--accept-data-loss"],
          {
            env: {
              ...process.env,
              DATABASE_URL: copyUrl,
              POSTGRES_URL_NON_POOLING: copyUrl,
              DATABASE_URL_UNPOOLED: copyUrl,
            },
            stdio: "pipe",
          },
        );
        await restore(dumpPath, copyUrl);
      }
    }

    console.log(`\n${n}. Clean again after the last rebuild`);
    const final = await blockingCount();
    check(
      final.blocking.length === 0,
      "no differences remain",
      final.blocking.map((d) => `${d.kind}:${d.subject}`).slice(0, 5).join(", "),
    );

    await copy.end();
  } finally {
    await admin
      .query(`DROP DATABASE IF EXISTS "${copyDb}" WITH (FORCE)`)
      .catch(async () => {
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${copyDb}'`,
        );
        await admin.query(`DROP DATABASE IF EXISTS "${copyDb}"`);
      });
    await admin.end();
    rmSync(workDir, { recursive: true, force: true });
  }

  console.log(
    failures === 0
      ? "\nALL PASSED — the comparison detects every kind of damage tested."
      : `\nFAILED — ${failures} check(s) did not pass.`,
  );
  process.exit(failures === 0 ? 0 : 1);
})();
