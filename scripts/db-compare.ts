/**
 * Prove two databases hold the same thing.
 *
 *   COMPARE_B=<other database url> npx tsx --env-file=.env scripts/db-compare.ts
 *   COMPARE_A=<url> COMPARE_B=<url> npx tsx scripts/db-compare.ts
 *
 * A defaults to the app's own database. Read only on both sides — it takes no
 * locks beyond ordinary snapshots and writes nothing, so it is safe to run
 * against production.
 *
 * Exits non-zero if anything blocking differs, so it can gate a migration.
 */
import { compareDatabases, reportComparison } from "./lib/db-compare";
import { connectionString, describeTarget } from "./lib/dump";

void (async () => {
  const b = process.env.COMPARE_B;
  if (!b) {
    console.error("Set COMPARE_B to the database to compare against.");
    console.error("  COMPARE_B=<url> npx tsx --env-file=.env scripts/db-compare.ts");
    process.exit(2);
  }
  const a = process.env.COMPARE_A ?? connectionString();

  const labelA = describeTarget(a);
  const labelB = describeTarget(b);
  console.log(`A = ${labelA}`);
  console.log(`B = ${labelB}\n`);

  const result = await compareDatabases({ label: "A", url: a }, { label: "B", url: b });
  const blocking = reportComparison(result, "A", "B");
  process.exit(blocking === 0 ? 0 : 1);
})();
