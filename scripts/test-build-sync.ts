/**
 * The build's database step decides, from the environment alone, whether to
 * touch a real database. Those are the two ways this project can hurt itself
 * at deploy time, so both directions are asserted here.
 *
 *   npx tsx scripts/test-build-sync.ts
 *
 * CI cannot catch a regression in scripts/build-db-sync.ts any other way: it
 * runs `npx next build` directly and never invokes `npm run build`, precisely
 * because that script used to reach for a database.
 *
 * The two failures this guards are not symmetric.
 *
 *   Skipping when it should sync ships code whose tables were never created.
 *   Syncing when it should skip is how the Preview builds broke, and would be
 *   far worse if Preview ever held a live connection string.
 *
 * Every case below runs against 127.0.0.1:1, a closed port, so no case can
 * reach a database even if the logic under test is wrong.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname ?? "scripts", "build-db-sync.ts");
const CLOSED = "postgresql://ci:hunter2@127.0.0.1:1/nodb";

type Result = { code: number; output: string };

/**
 * Run the script under a controlled environment.
 *
 * The parent's own DATABASE_URL and POSTGRES_URL_NON_POOLING are dropped, and
 * dotenv is pointed at a file that does not exist, so a developer's real .env
 * cannot decide the outcome of a test about what happens when there is no
 * datasource.
 */
function run(env: Record<string, string>): Result {
  const base = { ...process.env };
  delete base.DATABASE_URL;
  delete base.POSTGRES_URL_NON_POOLING;
  delete base.VERCEL_ENV;

  try {
    const output = execFileSync("npx", ["tsx", SCRIPT], {
      encoding: "utf8",
      stdio: "pipe",
      shell: process.platform === "win32",
      env: { ...base, DOTENV_CONFIG_PATH: "no-such-env-file.env", ...env },
    });
    return { code: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

let failures = 0;

/**
 * Structural signals, deliberately not prose.
 *
 * Both this script's messages talk ABOUT pushing and skipping, so matching the
 * bare words made a passing script look like a failing one. `run()` echoes each
 * command it executes on its own line, and the skip banner opens with a fixed
 * sentence, so both facts can be read without guessing at wording.
 */
const ranPush = (out: string) => /^> prisma db push$/m.test(out);
const skipped = (out: string) => /^Preview deployment: skipping/m.test(out);

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${name}`);
  if (detail) console.log(`        ${detail.split("\n").join("\n        ")}`);
}

console.log("Preview must skip, and must not invoke prisma:");
{
  const r = run({ VERCEL_ENV: "preview", DATABASE_URL: CLOSED });
  check("exits 0", r.code === 0, `exit ${r.code}\n${r.output}`);
  check("says it is skipping", skipped(r.output), r.output);
  check("never runs db push", !ranPush(r.output), r.output);
  check("never reaches a server", !/P1001|Can't reach/.test(r.output), r.output);
}

console.log("Production without a datasource must fail loudly, never skip:");
{
  const r = run({ VERCEL_ENV: "production" });
  check("exits non-zero", r.code !== 0, `exit ${r.code}\n${r.output}`);
  check("names the missing variables", /POSTGRES_URL_NON_POOLING/.test(r.output), r.output);
  check("does not claim to have skipped", !skipped(r.output), r.output);
}

console.log("Production with a datasource must sync:");
{
  const r = run({ VERCEL_ENV: "production", POSTGRES_URL_NON_POOLING: CLOSED });
  check("runs db push", ranPush(r.output), r.output);
  check("reached the configured host", /127\.0\.0\.1:1/.test(r.output), r.output);
  check("fails when the push fails", r.code !== 0, `exit ${r.code}`);
}

console.log("A machine with no VERCEL_ENV must sync, the same as before:");
{
  const r = run({ POSTGRES_URL_NON_POOLING: CLOSED });
  check("runs db push", ranPush(r.output), r.output);
  check("does not skip", !skipped(r.output), r.output);
}

console.log("The build log must never carry the credentials:");
{
  const r = run({ VERCEL_ENV: "production", POSTGRES_URL_NON_POOLING: CLOSED });
  check("no password", !/hunter2/.test(r.output), r.output);
  check("no full connection string", !/postgresql:\/\//.test(r.output), r.output);
}

console.log(
  failures === 0
    ? "\nCLEAN: the build syncs the schema everywhere except Preview, and never silently."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
