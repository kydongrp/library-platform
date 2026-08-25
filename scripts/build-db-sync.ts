/**
 * The database half of `npm run build`, made conditional on where the build is
 * running.
 *
 *   tsx scripts/build-db-sync.ts
 *
 * The build script used to open with `prisma db push && tsx
 * prisma/seed-if-empty.ts`, unconditionally. That is right on Vercel
 * Production, where the schema ships with the deploy because this project has
 * no migration history. It is wrong everywhere a database is deliberately
 * absent: Preview deployments have no DATABASE_URL, so `db push` died with
 * "The datasource.url property is required in your Prisma config file" about
 * seven seconds in, and every Dependabot pull request came back with a red
 * preview that said nothing about the dependency it was bumping.
 *
 * The rule is stated as an allowlist of one so the production path cannot be
 * weakened by accident: Preview skips, everything else syncs. In particular a
 * missing datasource on Production is a hard failure rather than a silent
 * skip. A build that quietly declined to push the schema would deploy code
 * expecting tables that are not there, which is worse than not deploying.
 *
 * CI does not use this script. It runs `npx next build` directly and points
 * the connection string at a closed port, which is the same idea reached from
 * the other direction: see .github/workflows/ci.yml.
 */
// Loaded exactly as prisma.config.ts loads it, and it has to happen here too:
// this script decides whether prisma runs, so it has to read the same file
// prisma would. Without it a developer whose connection string lives in .env
// rather than in a real environment variable would see this script refuse a
// build that used to work.
import "dotenv/config";
import { execSync } from "node:child_process";

/**
 * Vercel sets this to "production", "preview" or "development". It is unset on
 * a developer's machine, which therefore takes the syncing path, matching what
 * `npm run build` did locally before this script existed.
 */
const target = process.env.VERCEL_ENV ?? "local";

/**
 * Resolved the same way prisma.config.ts resolves it, and for the same reason:
 * DDL wants the direct connection, not the pooler.
 */
const datasource =
  process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL || "";

/**
 * Run a build step with npm's node_modules/.bin already on PATH, which it is
 * because this script is itself invoked from an npm script. Output is
 * inherited so the deploy log reads exactly as it did before.
 */
function run(command: string): void {
  console.log(`> ${command}`);
  try {
    execSync(command, { stdio: "inherit" });
  } catch (error) {
    // The step already printed its own diagnosis to the inherited stderr.
    // Rethrowing would bury it under a Node stack trace whose frames are all
    // inside child_process, so exit with the child's status instead and let
    // the real error be the last thing in the deploy log.
    const status = (error as { status?: number }).status;
    console.error(`\nBuild step failed: ${command}`);
    process.exit(typeof status === "number" && status !== 0 ? status : 1);
  }
}

if (target === "preview") {
  console.log(
    "Preview deployment: skipping `prisma db push` and the seed.\n" +
      "Preview has no database on purpose. Compiling only, so a preview proves\n" +
      "the branch builds; correctness against real data is CI's job and\n" +
      "Production's. Give the Preview environment a datasource only if you are\n" +
      "certain it is not the production one: this script would still skip the\n" +
      "push, but the running preview would then hold a live connection string.",
  );
  process.exit(0);
}

if (!datasource) {
  console.error(
    `No datasource for a ${target} build.\n` +
      "Set POSTGRES_URL_NON_POOLING (preferred) or DATABASE_URL. Refusing to\n" +
      "continue: skipping the schema push here would deploy code that expects\n" +
      "tables nobody created.",
  );
  process.exit(1);
}

// Host only, never the credentials: this line lands in a public build log.
const host = /@([^/?]+)/.exec(datasource)?.[1] ?? "unparsed";
console.log(`Syncing schema for a ${target} build against ${host}.`);

run("prisma db push");
run("tsx prisma/seed-if-empty.ts");
