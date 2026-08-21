/**
 * Restore a backup into a database.
 *
 *   RESTORE_URL=<target> npx tsx --env-file=.env scripts/restore.ts <dump.ndjson.gz>
 *
 * The target is RESTORE_URL, never DATABASE_URL: a restore replaces data, and
 * defaulting to the app's own database is how a drill becomes an outage. To
 * restore over production you must pass --i-understand-this-overwrites and
 * set RESTORE_URL to it explicitly.
 */
import { resolve } from "node:path";
import { restore, readManifest, connectionString, describeTarget } from "./lib/dump";

void (async () => {
  const args = process.argv.slice(2);
  const force = args.includes("--i-understand-this-overwrites");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("Usage: RESTORE_URL=<target> tsx scripts/restore.ts <dump.ndjson.gz>");
    process.exit(2);
  }
  const path = resolve(file);

  const target = process.env.RESTORE_URL;
  if (!target) {
    console.error("Refusing to run: set RESTORE_URL to the database to restore INTO.");
    console.error("This is deliberately separate from DATABASE_URL so a drill cannot hit production.");
    process.exit(2);
  }

  // Same-target guard: compare host+database, which is what actually decides
  // whether two URLs are the same database.
  let live = "";
  try {
    live = describeTarget(connectionString());
  } catch {
    /* no app URL in env; nothing to compare against */
  }
  if (live && describeTarget(target) === live && !force) {
    console.error(`Refusing to restore over ${live} — that is the app's live database.`);
    console.error("Re-run with --i-understand-this-overwrites if that is genuinely what you want.");
    process.exit(2);
  }

  const m = await readManifest(path);
  console.log(`Dump:   ${m.takenAt} · ${m.totalRows} rows · ${m.tableOrder.length} tables · from ${m.database}`);
  console.log(`Target: ${describeTarget(target)}${force ? "  [OVERWRITE FORCED]" : ""}`);

  const res = await restore(path, target);
  const mismatched = m.tableOrder.filter((t) => (res.inserted[t] ?? 0) !== (m.rowCounts[t] ?? 0));
  if (mismatched.length) {
    console.error(`FAILED: ${mismatched.length} table(s) restored a different row count than the dump:`);
    for (const t of mismatched.slice(0, 10))
      console.error(`  ${t}: dump ${m.rowCounts[t]} vs restored ${res.inserted[t] ?? 0}`);
    process.exit(1);
  }
  console.log(`OK  restored ${res.total} rows; every table matches the dump exactly.`);
})();
