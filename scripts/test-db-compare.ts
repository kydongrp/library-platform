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
 *
 * Two things will stop this test before it starts, neither of which is a bug in
 * the comparison it exists to check:
 *
 *   BACKUP_KEY. The dump holds member names and emails, so backup() refuses to
 *   write one in plaintext. This test supplies its own random key when none is
 *   set, because its dump lives in a temp directory that the finally block
 *   deletes and is never an artefact anyone keeps. scripts/backup.ts still
 *   refuses, which is where that rule earns its keep.
 *
 *   Prisma's AI-agent guard. `db push --accept-data-loss` is refused outright
 *   when Prisma detects an agent invoked it, and it is right to: the flag
 *   destroys everything in whatever database it names. Here that is always a
 *   database created seconds earlier and dropped in the finally block, but the
 *   guard cannot see the difference. Running this test yourself is unaffected;
 *   an agent needs PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION set to the text
 *   of the consent you gave it.
 */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { backup, restore, connectionString, describeTarget } from "./lib/dump";
import { applyAuditAppendOnly } from "./lib/harden";
import { compareDatabases } from "./lib/db-compare";

function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * Put the schema on the throwaway copy.
 *
 * The output is decoded because execFileSync throws an error whose stdout and
 * stderr are Buffers, and Node renders a Buffer as a list of byte values: a
 * failure here used to print two hundred numbers and no message, which made the
 * one step most likely to fail the one hardest to diagnose.
 */
function pushSchema(copyUrl: string): void {
  try {
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
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
    const output = `${err.stdout?.toString() ?? ""}\n${err.stderr?.toString() ?? ""}`.trim();

    // Prisma refuses destructive commands when it detects an AI agent driving
    // them. It is right to: the flag really does destroy data, and the guard
    // cannot see that this particular target is a database created seconds ago
    // for this test. Say so in one sentence rather than leaving the next reader
    // to decode a stack trace.
    if (/PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION/.test(output)) {
      throw new Error(
        [
          "prisma db push refused to run: it detected that an AI agent invoked it.",
          "",
          `This test pushes the schema onto ${new URL(copyUrl).pathname.slice(1)}, a throwaway database`,
          "it created moments ago and drops in its finally block. It never targets the live",
          "database, which it only ever reads. The guard cannot know that.",
          "",
          "Running this test yourself is unaffected. To let an agent run it, set",
          "PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION to the exact text of your consent.",
          "",
          output,
        ].join("\n"),
      );
    }
    throw new Error(`prisma db push failed (exit ${err.status}):\n${output}`);
  }
}

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}

void (async () => {
  // A throwaway key for a throwaway dump, so the test does not need an
  // operator's secret to run. The invariant backup() protects is that member
  // data never lands on disk in plaintext, and a random key keeps it: the dump
  // is still encrypted, and the key dies with the process.
  if (!process.env.BACKUP_KEY) {
    process.env.BACKUP_KEY = randomBytes(24).toString("hex");
    console.log("BACKUP_KEY was not set; using a random one for this run's temporary dump.");
  }

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
    pushSchema(copyUrl);
    {
      // Match production's hardening or the very first comparison fails on
      // the trigger diff.
      const h = new Client({ connectionString: copyUrl });
      await h.connect();
      await applyAuditAppendOnly(h);
      await h.end();
    }
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
        // The realistic tamper path now that the trigger exists: an attacker
        // with DDL rights disables it, deletes, and re-enables. The trigger
        // definitions end up identical, so only the row count betrays it,
        // which is exactly what this case must prove the comparison catches.
        label: "a deleted row (trigger disabled and restored)",
        kind: "counts",
        damage: `ALTER TABLE "AuditLog" DISABLE TRIGGER auditlog_append_only;
                 DELETE FROM "AuditLog" WHERE id = (SELECT id FROM "AuditLog" ORDER BY id LIMIT 1);
                 ALTER TABLE "AuditLog" ENABLE TRIGGER auditlog_append_only`,
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
        pushSchema(copyUrl);
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
      ? "\nALL PASSED. The comparison detects every kind of damage tested."
      : `\nFAILED: ${failures} check(s) did not pass.`,
  );
  process.exit(failures === 0 ? 0 : 1);
})();
