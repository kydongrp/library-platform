/**
 * Move this database to a Neon project in an account we administer.
 *
 *   npm run neon:move -- plan
 *   npm run neon:move -- create --org org-tiny-queen-44468184 --name "DLS Admin"
 *   npm run neon:move -- freeze
 *   npm run neon:move -- sync
 *   npm run neon:move -- verify
 *   npm run neon:move -- thaw
 *
 * Why this exists rather than a checklist: the database currently lives in a
 * Neon project (`autumn-frog-86115224`) that no account we can log into owns,
 * so its recovery window cannot be read or changed. Everything here is
 * re-runnable and verified, because the interesting failure mode in a database
 * move is not a crash, it is a move that appears to work.
 *
 * The new credentials are written to `.env.migration` (git-ignored) and never
 * printed. Only hostnames appear on stdout.
 *
 * Order that matters:
 *   create  -> project exists, 30-day window set and read back, schema applied
 *   freeze  -> the OLD database stops accepting writes, so the dump is final
 *   sync    -> dump the old, restore into the new, then compare the two
 *   verify  -> compare again any time, read only
 *   thaw    -> undo the freeze (rollback, or if the move is abandoned)
 *
 * Vercel is deliberately NOT touched here. Repointing production is a separate,
 * visible step; see docs/BACKUP.md.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { backup, restore, connectionString, describeTarget, clientFor } from "./lib/dump";
import { neonIdentity } from "./lib/neon-identity";
import { compareDatabases, reportComparison } from "./lib/db-compare";

const API = "https://console.neon.tech/api/v2";
const THIRTY_DAYS = 2_592_000;
const CRED_FILE = resolve(".env.migration");

/**
 * Neon needs TLS; mirror the parameters the existing connection strings use.
 * `verify-full` is spelled out rather than `require` deliberately. pg currently
 * treats `require` as an alias for `verify-full`, but pg 9 and
 * pg-connection-string 3 will move it to libpq semantics, which skip
 * certificate and hostname verification. Naming the strong mode means that
 * upgrade cannot silently downgrade TLS on a database holding learner records.
 */
const POOLED_PARAMS = "sslmode=verify-full&channel_binding=require";
const DIRECT_PARAMS = "sslmode=verify-full&channel_binding=require";

type Project = {
  id: string;
  name: string;
  org_id?: string;
  region_id?: string;
  pg_version?: number;
  history_retention_seconds?: number;
};
type Operation = { id: string; action: string; status: string; error?: string };
type ConnParams = {
  host: string;
  pooler_host?: string;
  database: string;
  role: string;
  password: string;
};
type CreateResponse = {
  project: Project;
  connection_uris?: { connection_uri: string; connection_parameters: ConnParams }[];
  branch?: { id: string };
  endpoints?: { id: string; host: string }[];
  operations?: Operation[];
};

function requireKey(): string {
  const key = process.env.NEON_API_KEY;
  if (!key) {
    console.error("NEON_API_KEY is not set.");
    console.error("It must belong to the Neon account that owns the TARGET organisation.");
    console.error("Create one at Neon console > Account settings > API keys and put it in .env.");
    process.exit(2);
  }
  return key;
}

async function api<T>(path: string, key: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const text = await res.text();
  // Never echo the key. Neon's own message is enough to act on.
  if (!res.ok) throw new Error(`Neon API ${res.status} on ${path}: ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const TERMINAL_OK = new Set(["finished", "skipped"]);
const PENDING = new Set(["scheduling", "running", "cancelling"]);

/**
 * Wait until the project has no work in flight.
 *
 * Neon returns 201 from POST /projects before the compute exists, and its own
 * docs say to wait for the operations to finish before connecting. Polling the
 * whole operation list rather than the ids from the create response also covers
 * the retries Neon schedules itself, which carry ids the create response never
 * mentioned.
 */
async function waitForOperations(projectId: string, key: string): Promise<void> {
  const deadline = Date.now() + 5 * 60_000;
  for (let attempt = 0; ; attempt++) {
    const { operations } = await api<{ operations: Operation[] }>(
      `/projects/${projectId}/operations?limit=100`,
      key,
    );
    const pending = operations.filter((o) => PENDING.has(o.status));
    const bad = operations.filter((o) => !TERMINAL_OK.has(o.status) && !PENDING.has(o.status));
    if (pending.length === 0) {
      if (bad.length)
        throw new Error(
          `Neon operations did not succeed: ${bad
            .map((o) => `${o.action}=${o.status}${o.error ? ` (${o.error})` : ""}`)
            .join(", ")}`,
        );
      return;
    }
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting for ${pending.map((o) => o.action).join(", ")} on ${projectId}`,
      );
    if (attempt === 0) console.log(`  waiting for ${pending.map((o) => o.action).join(", ")}`);
    // Neon rate-limits at 700 req/min; 1.5s is polite and still prompt.
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function buildUrl(p: ConnParams, pooled: boolean): string {
  const host = pooled ? (p.pooler_host ?? p.host.replace(/^(ep-[^.]+)/, "$1-pooler")) : p.host;
  const params = pooled ? POOLED_PARAMS : DIRECT_PARAMS;
  return `postgresql://${encodeURIComponent(p.role)}:${encodeURIComponent(p.password)}@${host}/${p.database}?${params}`;
}

/** Write the target's credentials where only this machine can read them. */
function writeCreds(pooled: string, direct: string, meta: Record<string, string>): void {
  const body = [
    "# Credentials for the Neon project this database is moving TO.",
    "# Written by scripts/neon-move.ts. Git-ignored (.env*). Not loaded by anything",
    "# automatically: `npm run neon:move -- sync` reads it explicitly.",
    ...Object.entries(meta).map(([k, v]) => `# ${k}: ${v}`),
    "",
    `DATABASE_URL=${pooled}`,
    `DATABASE_URL_UNPOOLED=${direct}`,
    `POSTGRES_URL_NON_POOLING=${direct}`,
    "",
  ].join("\n");
  writeFileSync(CRED_FILE, body, { mode: 0o600 });
}

function readCreds(): { pooled: string; direct: string } {
  if (!existsSync(CRED_FILE))
    throw new Error(`${CRED_FILE} does not exist. Run \`npm run neon:move -- create\` first.`);
  const text = readFileSync(CRED_FILE, "utf8");
  const get = (name: string) => {
    const m = text.match(new RegExp(`^${name}=(.+)$`, "m"));
    if (!m) throw new Error(`${CRED_FILE} has no ${name}`);
    return m[1].trim();
  };
  return { pooled: get("DATABASE_URL"), direct: get("POSTGRES_URL_NON_POOLING") };
}

/** Apply the current Prisma schema to `url`. */
function pushSchema(url: string): void {
  // Spawn the Prisma CLI entry point on this node binary: npx.cmd fails with
  // EINVAL on Windows without a shell. And override ALL THREE url variables:
  // prisma.config.ts prefers POSTGRES_URL_NON_POOLING, so overriding only
  // DATABASE_URL would push this schema at the old production database.
  execFileSync(
    process.execPath,
    [resolve("node_modules/prisma/build/index.js"), "db", "push", "--accept-data-loss"],
    {
      env: {
        ...process.env,
        DATABASE_URL: url,
        POSTGRES_URL_NON_POOLING: url,
        DATABASE_URL_UNPOOLED: url,
      },
      stdio: "pipe",
    },
  );
}

function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * The drill and the test-database provisioner both need to CREATE DATABASE on
 * a `postgres` database. Better to find that out now than during a cutover.
 */
async function checkAdminCapability(direct: string): Promise<string[]> {
  const problems: string[] = [];
  try {
    const c = new Client({ connectionString: withDatabase(direct, "postgres") });
    c.on("error", () => {});
    await c.connect();
    const r = await c.query<{ createdb: boolean }>(
      `SELECT rolcreatedb AS createdb FROM pg_roles WHERE rolname = current_user`,
    );
    if (!r.rows[0]?.createdb) problems.push("the role cannot CREATE DATABASE");
    await c.end();
  } catch (e) {
    problems.push(`cannot connect to the "postgres" database: ${(e as Error).message}`);
  }
  return problems;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function describeSource(): Promise<void> {
  const id = await neonIdentity();
  console.log("Source (the database this app uses right now)");
  console.log(`  host     : ${id.host}`);
  console.log(`  postgres : ${id.serverVersion}`);
  console.log(`  project  : ${id.projectId}`);
  console.log(`  branch   : ${id.branchId}`);
  console.log(`  endpoint : ${id.endpointId}`);
}

/** Stop the source accepting writes, so the dump is the final state. */
async function setReadOnly(on: boolean): Promise<void> {
  const url = connectionString();
  const c = await clientFor(url, "freeze");
  try {
    const db = (await c.query<{ d: string }>("SELECT current_database() AS d")).rows[0].d;
    if (on) {
      await c.query(`ALTER DATABASE "${db}" SET default_transaction_read_only = on`);
      // The setting applies when a session connects, so existing pooled
      // connections (Vercel functions, a stray psql, Prisma Studio) keep
      // writing until they reconnect. Cut them.
      const killed = await c.query<{ pid: number }>(
        `SELECT pg_terminate_backend(pid) AS pid FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db],
      );
      console.log(`Froze ${describeTarget(url)}: writes refused, ${killed.rowCount} session(s) cut.`);
      console.log("Existing sessions reconnect read-only. Reverse with `neon:move -- thaw`.");
    } else {
      await c.query(`ALTER DATABASE "${db}" RESET default_transaction_read_only`);
      console.log(`Thawed ${describeTarget(url)}: writes allowed again on new connections.`);
    }
  } finally {
    await c.end().catch(() => {});
  }
}

async function cmdCreate(): Promise<void> {
  const key = requireKey();
  const org = arg("org");
  const name = arg("name") ?? "DLS Admin";
  const pgVersion = Number(arg("pg") ?? 18);
  if (!org) {
    console.error("Pass --org <org-id>. `npm run neon:move -- plan` lists the ones the key can see.");
    process.exit(2);
  }

  const src = await neonIdentity();
  const region = arg("region") ?? "aws-ap-southeast-1";

  // Idempotent: a re-run after a partial failure should adopt the project it
  // already made rather than making a second one.
  const { projects } = await api<{ projects: Project[] }>(
    `/projects?org_id=${encodeURIComponent(org)}&limit=100`,
    key,
  );
  const existing = projects.find((p) => p.name === name);
  if (existing && existing.id === src.projectId) {
    console.error(`${name} (${existing.id}) IS the source database. Nothing to move.`);
    process.exit(2);
  }

  let project: Project;
  let creds: ConnParams | null = null;

  if (existing) {
    console.log(`Reusing existing project ${existing.name} (${existing.id})`);
    project = existing;
    await waitForOperations(project.id, key);
  } else {
    console.log(`Creating project "${name}" in ${org}, region ${region}, Postgres ${pgVersion}`);
    const created = await api<CreateResponse>("/projects", key, {
      method: "POST",
      body: JSON.stringify({
        project: {
          name,
          org_id: org,
          region_id: region,
          pg_version: pgVersion,
          // Accepted at creation, so the recovery window is never briefly short.
          history_retention_seconds: THIRTY_DAYS,
          // Without this the password cannot be retrieved later, only reset.
          store_passwords: true,
          branch: { name: "main", database_name: "neondb", role_name: "neondb_owner" },
        },
      }),
    });
    project = created.project;
    creds = created.connection_uris?.[0]?.connection_parameters ?? null;
    console.log(`  created ${project.id}`);
    await waitForOperations(project.id, key);
  }

  if (!creds) {
    // Reusing a project, or a create response without connection parameters.
    const uri = await api<{ uri: string }>(
      `/projects/${project.id}/connection_uri?database_name=neondb&role_name=neondb_owner`,
      key,
    );
    const u = new URL(uri.uri);
    creds = {
      host: u.hostname,
      database: u.pathname.slice(1),
      role: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
  }

  const fresh = await api<{ project: Project }>(`/projects/${project.id}`, key);
  const window = fresh.project.history_retention_seconds ?? 0;
  console.log(`  region   : ${fresh.project.region_id}`);
  console.log(`  postgres : ${fresh.project.pg_version}`);
  console.log(`  window   : ${window}s (${(window / 86_400).toFixed(0)} days)`);

  if (window !== THIRTY_DAYS) {
    console.log("  raising the history window to 30 days");
    await api(`/projects/${project.id}`, key, {
      method: "PATCH",
      body: JSON.stringify({ project: { history_retention_seconds: THIRTY_DAYS } }),
    });
    const after = await api<{ project: Project }>(`/projects/${project.id}`, key);
    const now = after.project.history_retention_seconds ?? 0;
    if (now !== THIRTY_DAYS) {
      console.error(`  FAILED: window reads back as ${now}s, not ${THIRTY_DAYS}s.`);
      console.error("  A plan ceiling is capping it (Free 6h, Launch 7d, Scale 30d).");
      process.exit(1);
    }
    console.log(`  confirmed ${now}s`);
  }

  const pooled = buildUrl(creds, true);
  const direct = buildUrl(creds, false);
  writeCreds(pooled, direct, {
    project: project.id,
    region: String(fresh.project.region_id),
    postgres: String(fresh.project.pg_version),
    createdFor: `move from ${src.projectId}`,
  });
  console.log(`\nCredentials written to ${CRED_FILE} (git-ignored, not printed).`);
  console.log(`  pooled host : ${new URL(pooled).hostname}`);
  console.log(`  direct host : ${new URL(direct).hostname}`);

  const problems = await checkAdminCapability(direct);
  for (const p of problems) console.log(`  NOTE: ${p}; backup:drill and db:test:provision need this`);

  console.log("\nApplying the Prisma schema");
  pushSchema(direct);
  const c = await clientFor(direct, "target");
  const n = await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'public'`,
  );
  await c.end();
  console.log(`  ${n.rows[0].n} tables created`);
  console.log("\nNext: `npm run neon:move -- freeze` then `npm run neon:move -- sync`.");
}

async function cmdSync(): Promise<void> {
  const { direct } = readCreds();
  const source = connectionString();

  // A restore truncates before it loads. If .env.migration ever named the
  // source, this would wipe production and reload it from its own dump, which
  // would probably even succeed, and would still be an outage.
  if (describeTarget(direct) === describeTarget(source)) {
    console.error(`Refusing to sync: ${CRED_FILE} points at the source itself (${describeTarget(source)}).`);
    process.exit(2);
  }

  const src = await clientFor(source, "source");
  const ro = await src.query<{ ro: string }>(`SELECT current_setting('transaction_read_only') AS ro`);
  await src.end();
  if (ro.rows[0].ro !== "on")
    console.log("WARNING: the source still accepts writes. Anything written from now on is lost.\n");

  mkdirSync("backups", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dumpPath = resolve("backups", `dls-move-${stamp}.ndjson.gz`);

  console.log(`1. Dump ${describeTarget(source)}`);
  const { manifest, bytes } = await backup(dumpPath, source);
  console.log(`   ${manifest.totalRows} rows, ${manifest.tableOrder.length} tables, ${(bytes / 1024).toFixed(1)} KB`);

  console.log(`\n2. Restore into ${describeTarget(direct)}`);
  const res = await restore(dumpPath, direct);
  const wrong = manifest.tableOrder.filter((t) => (res.inserted[t] ?? 0) !== (manifest.rowCounts[t] ?? 0));
  if (wrong.length) {
    console.error(`   FAILED: ${wrong.length} table(s) restored a different count: ${wrong.slice(0, 5).join(", ")}`);
    process.exit(1);
  }
  console.log(`   ${res.total} rows restored, every table matching the dump`);

  console.log("\n3. Compare");
  await cmdVerify();
}

async function cmdVerify(): Promise<void> {
  const { direct } = readCreds();
  const source = connectionString();
  const result = await compareDatabases(
    { label: "old", url: source },
    { label: "new", url: direct },
  );
  const blocking = reportComparison(result, "old", "new");
  if (blocking > 0) {
    console.error("\nThe copy is NOT equivalent. Do not repoint production.");
    process.exit(1);
  }
  console.log("\nThe new database matches the old one. Safe to repoint production.");
}

/**
 * A watermark for the source database.
 *
 * A clean comparison before cutover says nothing about writes that land between
 * the comparison and the switch, and "we told everyone to stop" is not
 * evidence. Every admin mutation in src/app/actions/ calls audit(), so AuditLog
 * is a near-complete write log; the WAL position catches everything else,
 * including paths nobody thought about (the portal bumps ApiClient.lastUsedAt
 * on an authenticated read). Take one at freeze, one at cutover, and compare.
 */
async function cmdWatermark(): Promise<void> {
  const url = connectionString();
  const c = await clientFor(url, "watermark");
  try {
    const r = await c.query<{
      audits: string;
      last_audit: string | null;
      lsn: string;
      tuples: string | null;
      stats_reset: string | null;
      read_only: string;
    }>(
      `SELECT (SELECT count(*)::text FROM "AuditLog")                  AS audits,
              (SELECT max(at)::text FROM "AuditLog")                   AS last_audit,
              pg_current_wal_lsn()::text                               AS lsn,
              (SELECT sum(n_tup_ins + n_tup_upd + n_tup_del)::text
                 FROM pg_stat_user_tables)                             AS tuples,
              (SELECT stats_reset::text FROM pg_stat_database
                WHERE datname = current_database())                      AS stats_reset,
              current_setting('transaction_read_only')                 AS read_only`,
    );
    const w = r.rows[0];
    console.log(`Watermark for ${describeTarget(url)}`);
    console.log(`  read only  : ${w.read_only}`);
    console.log(`  audit rows : ${w.audits}`);
    console.log(`  last audit : ${w.last_audit ?? "(none)"}`);
    console.log(`  WAL lsn    : ${w.lsn}`);
    console.log(`  tuples w/r : ${w.tuples ?? "?"} (since ${w.stats_reset ?? "?"}, resets on compute restart)`);
    console.log("");
    console.log("Movement in audit rows or WAL position between the final dump and the");
    console.log("switch is a write that did not travel. Compare, do not assume.");
  } finally {
    await c.end().catch(() => {});
  }
}

/**
 * A Neon branch on the TARGET, as a restore point independent of the history
 * window.
 *
 * The Vercel build runs `prisma db push && seed-if-empty`, and the seed has a
 * destructive branch that fires when the resource count is zero. A branch taken
 * once the data is verified turns that from "restore the whole dump again" into
 * a seconds-long rollback.
 */
async function cmdBranch(): Promise<void> {
  const key = requireKey();
  const { direct } = readCreds();
  const target = await neonIdentity(direct);
  const name = arg("branch-name") ?? `verified-restore-${new Date().toISOString().slice(0, 10)}`;
  console.log(`Creating branch "${name}" on ${target.projectId}`);
  await api(`/projects/${target.projectId}/branches`, key, {
    method: "POST",
    body: JSON.stringify({ branch: { name, parent_id: target.branchId } }),
  });
  await waitForOperations(target.projectId, key);
  const { branches } = await api<{ branches: { id: string; name: string }[] }>(
    `/projects/${target.projectId}/branches`,
    key,
  );
  const made = branches.find((b) => b.name === name);
  console.log(made ? `  created ${made.id}` : "  WARNING: branch not visible after creation");
  console.log("Restore from it in the Neon console if the cutover goes wrong.");
}

/**
 * Everything in the source database that a public-schema table dump does not
 * carry. All of it is empty or platform-owned today; the point is to say so out
 * loud rather than find out otherwise afterwards.
 */
async function reportUncoveredObjects(): Promise<void> {
  const c = await clientFor(connectionString(), "audit");
  try {
    const rows = async (sql: string) => (await c.query<Record<string, string>>(sql)).rows;
    const schemas = await rows(
      `SELECT n.nspname AS name, count(t.tablename)::text AS tables
         FROM pg_namespace n LEFT JOIN pg_tables t ON t.schemaname = n.nspname
        WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
          AND n.nspname <> 'public'
        GROUP BY n.nspname ORDER BY n.nspname`,
    );
    const roles = await rows(
      `SELECT rolname AS name FROM pg_roles
        WHERE rolcanlogin AND rolname NOT LIKE 'pg_%' ORDER BY rolname`,
    );
    const other = await rows(
      `SELECT table_name AS name, table_type AS kind FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type <> 'BASE TABLE'`,
    );
    const ext = await rows(`SELECT extname AS name FROM pg_extension ORDER BY extname`);
    const fns = await rows(
      `SELECT count(*)::text AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'`,
    );

    console.log("Objects a public-table dump does not carry");
    console.log(`  other schemas  : ${schemas.map((r) => `${r.name} (${r.tables} tables)`).join(", ") || "none"}`);
    console.log(`  login roles    : ${roles.map((r) => r.name).join(", ")}`);
    console.log(`  views/matviews : ${other.map((r) => `${r.name}:${r.kind}`).join(", ") || "none"}`);
    console.log(`  extensions     : ${ext.map((r) => r.name).join(", ")}`);
    console.log(`  functions      : ${fns[0]?.n ?? "?"}`);
    if (schemas.length)
      console.log(
        "  NOTE: a non-public schema exists. Confirm it holds no application data\n" +
          "        before relying on this move (neon_auth is Neon's own, unused here).",
      );
  } finally {
    await c.end().catch(() => {});
  }
}

async function cmdPlan(): Promise<void> {
  await describeSource();
  console.log("");
  await reportUncoveredObjects();
  const key = process.env.NEON_API_KEY;
  if (!key) {
    console.log("\nSet NEON_API_KEY to list the organisations available as a destination.");
    return;
  }
  const { organizations } = await api<{ organizations: { id: string; name: string; plan?: string }[] }>(
    "/users/me/organizations",
    key,
  );
  console.log("\nDestinations this API key can see");
  for (const org of organizations ?? []) {
    const { projects } = await api<{ projects: Project[] }>(
      `/projects?org_id=${encodeURIComponent(org.id)}&limit=100`,
      key,
    );
    console.log(`  ${org.name} [${org.id}] plan=${org.plan ?? "?"}`);
    for (const p of projects ?? [])
      console.log(
        `    - ${p.name} (${p.id}) pg${p.pg_version ?? "?"} ${p.region_id ?? ""} window=${p.history_retention_seconds ?? "?"}s`,
      );
  }
  console.log("");
  await reportUncoveredObjects();
  console.log(
    "\nA 30-day history window needs the Scale plan. Create with:\n" +
      '  npm run neon:move -- create --org <org-id> --name "DLS Admin"',
  );
}

void (async () => {
  const cmd = process.argv[2];
  switch (cmd) {
    case "plan":
      return cmdPlan();
    case "create":
      return cmdCreate();
    case "freeze":
      return setReadOnly(true);
    case "thaw":
      return setReadOnly(false);
    case "sync":
      return cmdSync();
    case "verify":
      return cmdVerify();
    case "watermark":
      return cmdWatermark();
    case "branch":
      return cmdBranch();
    default:
      console.error(
        "Usage: npm run neon:move -- <plan|create|freeze|watermark|sync|verify|branch|thaw>",
      );
      console.error("  plan    show the source database and the destinations the key can see");
      console.error("  create  create the target project, set a 30-day window, apply the schema");
      console.error("  freeze  stop the OLD database accepting writes");
      console.error("  sync    dump the old, restore into the new, compare");
      console.error("  verify  compare old and new (read only)");
      console.error("  watermark  the source's write position, to prove nothing leaked past the dump");
      console.error("  branch  a Neon branch of the new database, as a restore point");
      console.error("  thaw    let the OLD database accept writes again");
      process.exit(2);
  }
})();
