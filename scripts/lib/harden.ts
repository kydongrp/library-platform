/**
 * Shared database-hardening DDL, so the production database and every
 * throwaway copy built by the drills carry identical rules: db-compare's
 * rules axis diffs pg_trigger definitions, so a copy without this trigger
 * would flag every drill as a mismatch.
 */
import type { Client } from "pg";

/** Install (idempotently) the trigger that makes "AuditLog" append-only. */
export async function applyAuditAppendOnly(c: Client): Promise<void> {
  await c.query(`
    CREATE OR REPLACE FUNCTION auditlog_block_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'AuditLog is append-only: % is not allowed', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await c.query(`DROP TRIGGER IF EXISTS auditlog_append_only ON "AuditLog"`);
  await c.query(`
    CREATE TRIGGER auditlog_append_only
    BEFORE UPDATE OR DELETE ON "AuditLog"
    FOR EACH ROW EXECUTE FUNCTION auditlog_block_mutation();
  `);
}
