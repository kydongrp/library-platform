/**
 * Database-level hardening: make the audit trail append-only where the
 * application cannot be trusted to be the only writer.
 *
 *   npm run db:harden:test   # against .env.test first
 *   npm run db:harden        # then against the database .env names
 *
 * Installs a trigger that rejects UPDATE and DELETE on "AuditLog". TRUNCATE is
 * deliberately NOT blocked: the disaster-recovery restore path truncates every
 * table before re-inserting, and row triggers do not fire on TRUNCATE anyway.
 *
 * Idempotent and reversible (DROP TRIGGER auditlog_append_only, DROP FUNCTION
 * auditlog_block_mutation). Prisma does not manage triggers, so a future
 * `prisma db push` that RECREATES the AuditLog table (rather than altering it)
 * would drop this silently; the script verifies the trigger by attempting a
 * mutation, so re-running it after schema work is the check.
 */
import { Client } from "pg";
import { connectionString, describeTarget } from "./lib/dump";
import { applyAuditAppendOnly } from "./lib/harden";

void (async () => {
  const url = connectionString();
  console.log(`Hardening ${describeTarget(url)}`);
  const c = new Client({ connectionString: url });
  c.on("error", (e) => console.error(`  [db] ${e.message}`));
  await c.connect();
  try {
    await applyAuditAppendOnly(c);
    console.log("  trigger installed");

    // Prove it bites, inside a transaction that never commits. An empty table
    // updates zero rows and proves nothing, so a probe row is inserted first.
    await c.query("BEGIN");
    const blocked = { update: false, delete: false };
    try {
      await c.query(
        `INSERT INTO "AuditLog" (id, actor, action, summary)
         VALUES ('__harden_probe__', 'db-harden', 'harden.probe', 'trigger verification probe')`,
      );
      try {
        await c.query(`UPDATE "AuditLog" SET summary = 'tampered' WHERE id = '__harden_probe__'`);
      } catch {
        blocked.update = true;
      }
      try {
        await c.query("ROLLBACK; BEGIN");
        await c.query(
          `INSERT INTO "AuditLog" (id, actor, action, summary)
           VALUES ('__harden_probe__', 'db-harden', 'harden.probe', 'trigger verification probe')`,
        );
        await c.query(`DELETE FROM "AuditLog" WHERE id = '__harden_probe__'`);
      } catch {
        blocked.delete = true;
      }
    } finally {
      await c.query("ROLLBACK");
    }
    if (!blocked.update || !blocked.delete) {
      throw new Error(
        `Trigger verification FAILED: update blocked=${blocked.update}, delete blocked=${blocked.delete}`,
      );
    }
    console.log("  verified: UPDATE and DELETE both rejected, probe rolled back");
    console.log("OK  AuditLog is append-only at the database layer.");
  } finally {
    await c.end();
  }
})();
