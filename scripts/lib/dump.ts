/**
 * Portable logical backup for the DLS Admin database.
 *
 * Deliberately pure node-postgres rather than pg_dump: the dump has to be
 * runnable from a Windows dev box, a CI runner and a serverless function
 * without anyone installing matching Postgres client binaries, and a version
 * mismatch between pg_dump and the server is a classic reason a backup turns
 * out to be unusable exactly when it is needed.
 *
 * Format: NDJSON, gzipped. Line 1 is a manifest; every later line is
 * {"t": "<table>", "r": {...row...}}. Streaming both ways, so restoring never
 * holds the whole database in memory.
 */

import { Client, types as pgTypes } from "pg";
import type { TypeFormat } from "pg-types";
import { encrypt, decrypt, isEncrypted, hasBackupKey } from "./crypt";

/**
 * v2 stores temporal columns as the server's own text, never as a UTC ISO
 * string. v1 did the latter, which silently shifted every naive timestamp by
 * the UTC offset of the machine that took the dump (see clientFor below).
 */
export const DUMP_FORMAT = "dls-ndjson-2";
/** v1 dumps are readable but their naive timestamps are offset. */
export const LEGACY_DUMP_FORMAT = "dls-ndjson-1";

export type Manifest = {
  /** v1 dumps still read, so a manifest may carry either version. */
  format: typeof DUMP_FORMAT | typeof LEGACY_DUMP_FORMAT;
  takenAt: string;
  database: string;
  serverVersion: string;
  /** Restore order. Reverse it to truncate without tripping foreign keys. */
  tableOrder: string[];
  /** Row counts at dump time; the restore drill asserts against these. */
  rowCounts: Record<string, number>;
  totalRows: number;
  /**
   * table -> column -> information_schema data_type. Restore needs this:
   * node-postgres serialises a JS array as a Postgres array literal, so a
   * json column holding an array (MarcTagDef.subfields) would be sent as
   * `{...}` and rejected with "invalid input syntax for type json".
   */
  columnTypes: Record<string, Record<string, string>>;
};

/** Columns we must round-trip verbatim, keyed by table.column. */
type ColumnMeta = { name: string; dataType: string };

export function connectionString(env: NodeJS.ProcessEnv = process.env): string {
  // The unpooled endpoint is the right one for long single-session work: the
  // pooler can drop a session mid-copy.
  const url = env.DATABASE_URL_UNPOOLED ?? env.POSTGRES_URL_NON_POOLING ?? env.DATABASE_URL;
  if (!url) throw new Error("No database URL in the environment (DATABASE_URL).");
  return url;
}

/** Host and database only — safe to print, never the credentials. */
export function describeTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return "(unparseable url)";
  }
}

async function listTables(c: Client): Promise<string[]> {
  const r = await c.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  return r.rows.map((x) => x.tablename);
}

async function listColumns(c: Client, table: string): Promise<ColumnMeta[]> {
  const r = await c.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map((x) => ({ name: x.column_name, dataType: x.data_type }));
}

/**
 * Topologically sort tables so parents are restored before children. Derived
 * from the live catalog rather than hardcoded, so it cannot drift from the
 * schema. Cycles (a self-reference, or a mutually-dependent pair) are broken
 * by falling back to name order for the tables involved; the restore also
 * defers constraint checks, so ordering is an optimisation, not a promise.
 */
export async function foreignKeyOrder(c: Client): Promise<string[]> {
  const tables = await listTables(c);
  const deps = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  const fks = await c.query<{ child: string; parent: string }>(
    `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
     FROM pg_constraint c
     JOIN pg_class ch ON ch.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = ch.relnamespace
     WHERE c.contype = 'f' AND n.nspname = 'public'`,
  );
  const unquote = (s: string) => s.replace(/^"|"$/g, "").replace(/^public\./, "").replace(/^"|"$/g, "");
  for (const { child, parent } of fks.rows) {
    const ch = unquote(child);
    const pa = unquote(parent);
    if (ch === pa) continue; // self-reference: no ordering constraint to honour
    deps.get(ch)?.add(pa);
  }

  const out: string[] = [];
  const done = new Set<string>();
  // Kahn's algorithm, name-ordered for a stable dump between runs.
  let progress = true;
  while (out.length < tables.length && progress) {
    progress = false;
    for (const t of tables) {
      if (done.has(t)) continue;
      const remaining = [...(deps.get(t) ?? [])].filter((p) => !done.has(p));
      if (remaining.length === 0) {
        out.push(t);
        done.add(t);
        progress = true;
      }
    }
  }
  // Anything left is in a cycle: append deterministically.
  for (const t of tables) if (!done.has(t)) out.push(t);
  return out;
}

/**
 * Postgres OIDs the driver must not convert: every date/time type, json and
 * jsonb, including the array forms.
 *
 * These are handed a pass-through parser below so the driver never converts
 * them to a JS value. That conversion is where a backup quietly corrupts data:
 * node-postgres reads `timestamp without time zone` as a LOCAL time, and
 * `Date.toISOString()` then writes it back as UTC. Inserting that string into
 * a naive timestamp column stores the UTC wall clock, so every timestamp in
 * the database moves by the dumping machine's UTC offset — eight hours in
 * Singapore, and eight more on every further round trip. The schema has 91
 * naive timestamp columns, so that is due dates, fines, audit trails and loan
 * history all silently wrong, while row counts and null checks still pass.
 *
 * Keeping them as text removes the timezone from the round trip entirely.
 */
const PASS_THROUGH_OIDS = [
  1082, // date
  1083, // time
  1114, // timestamp
  1184, // timestamptz
  1266, // timetz
  1186, // interval
  1115, // timestamp[]
  1182, // date[]
  1183, // time[]
  1185, // timestamptz[]
  1187, // interval[]
  1270, // timetz[]
  // json and jsonb for the same reason: node-postgres runs JSON.parse on
  // them, and JavaScript numbers are IEEE-754 doubles. An integer beyond
  // 2^53 comes back imprecise, and 1.0 comes back as 1 — then gets
  // re-serialised on restore, so the dump is quietly not what was dumped.
  // Nothing in the data hits that today (checked), but MARC subfields and
  // acquisition amounts are exactly where it would appear.
  114, // json
  3802, // jsonb
  199, // json[]
  3807, // jsonb[]
];

const passThrough = (v: string) => v;

/**
 * A client that reads and writes values byte-faithfully.
 *
 * Two things matter: temporal types come back as the server's own text (see
 * above), and the session is pinned to UTC with ISO output so that text is
 * canonical no matter where the dump is taken from or restored to.
 */
export async function clientFor(url: string, label = "connection"): Promise<Client> {
  const c = new Client({
    connectionString: url,
    types: {
      getTypeParser: ((oid: number, format?: TypeFormat) =>
        PASS_THROUGH_OIDS.includes(oid) ? passThrough : pgTypes.getTypeParser(oid, format)) as never,
    },
  });
  c.on("error", (e) => console.error(`  [${label}] ${e.message}`));
  await c.connect();
  // Canonical rendering, so a dump taken anywhere restores identically.
  await c.query("SET TIME ZONE 'UTC'");
  await c.query("SET DateStyle = 'ISO, MDY'");
  await c.query("SET IntervalStyle = 'postgres'");
  return c;
}

/**
 * Encode one row for JSON. Buffers go to base64 and bigints to strings, both
 * reversed on restore. Temporal values arrive as text and stay text. The Date
 * branch is a backstop: with the parser overrides above nothing should reach
 * it, and if something does, it is better to keep the value than to drop it.
 */
function encodeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return { __b64: v.toString("base64") };
  if (typeof v === "bigint") return v.toString();
  return v;
}

function decodeValue(v: unknown, dataType?: string): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && "__b64" in (v as Record<string, unknown>)) {
    return Buffer.from(String((v as Record<string, unknown>).__b64), "base64");
  }
  // json/jsonb must go back as a JSON string. Left as a JS value, an array
  // would be sent as a Postgres array literal and rejected. Dumps taken with
  // the pass-through parser already hold the server's own text, so only an
  // older dump needs re-serialising.
  if (dataType === "json" || dataType === "jsonb")
    return typeof v === "string" ? v : JSON.stringify(v);
  return v;
}

export type BackupResult = { manifest: Manifest; bytes: number; path: string; encrypted: boolean };

export async function backup(outPath: string, url: string): Promise<BackupResult> {
  const c = await clientFor(url, "backup connection");
  try {
    // One consistent snapshot for the whole dump: without this, a dump taken
    // while staff are working can capture a child row whose parent it missed.
    await c.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");

    const [{ version }] = (await c.query<{ version: string }>("SELECT version()")).rows;
    const [{ db }] = (await c.query<{ db: string }>("SELECT current_database() AS db")).rows;
    const tableOrder = await foreignKeyOrder(c);

    const rowCounts: Record<string, number> = {};
    const columnTypes: Record<string, Record<string, string>> = {};
    const chunks: string[] = [];
    let totalRows = 0;

    for (const t of tableOrder) {
      const cols = await listColumns(c, t);
      columnTypes[t] = Object.fromEntries(cols.map((col) => [col.name, col.dataType]));
      const r = await c.query(`SELECT * FROM "${t}"`);
      rowCounts[t] = r.rowCount ?? 0;
      totalRows += rowCounts[t];
      for (const row of r.rows) {
        const enc: Record<string, unknown> = {};
        for (const col of cols) enc[col.name] = encodeValue((row as Record<string, unknown>)[col.name]);
        chunks.push(JSON.stringify({ t, r: enc }));
      }
    }

    const manifest: Manifest = {
      format: DUMP_FORMAT,
      takenAt: new Date().toISOString(),
      database: db,
      serverVersion: version.split(" ").slice(0, 2).join(" "),
      tableOrder,
      rowCounts,
      totalRows,
      columnTypes,
    };

    await c.query("COMMIT");

    const body = [JSON.stringify(manifest), ...chunks].join("\n") + "\n";
    const { gzipSync } = await import("node:zlib");
    const { writeFileSync, statSync } = await import("node:fs");
    const gz = gzipSync(Buffer.from(body, "utf8"), { level: 9 });
    // Encrypt whenever a key is configured, so a dump on disk is never
    // readable personal data.
    const encrypted = hasBackupKey();
    writeFileSync(outPath, encrypted ? encrypt(gz) : gz);

    // Read it back. A backup that reports success and cannot be opened is the
    // worst possible outcome, and with BACKUP_KEY passed inline a typo produces
    // exactly that: a well-formed file nobody can decrypt, discovered months
    // later when it is needed.
    const readBack = await readManifest(outPath);
    if (readBack.totalRows !== manifest.totalRows)
      throw new Error(
        `Wrote ${manifest.totalRows} rows but the file reads back as ${readBack.totalRows}.`,
      );

    return { manifest, bytes: statSync(outPath).size, path: outPath, encrypted };
  } finally {
    await c.end();
  }
}

/** Decode a dump file to its NDJSON lines, decrypting when needed. */
async function readLines(path: string): Promise<string[]> {
  const { readFileSync } = await import("node:fs");
  const { gunzipSync } = await import("node:zlib");
  const raw: Buffer = readFileSync(path);
  let buf: Buffer = raw;
  if (isEncrypted(raw)) {
    if (!hasBackupKey())
      throw new Error(`${path} is encrypted but BACKUP_KEY is not set.`);
    buf = decrypt(raw);
  }
  return gunzipSync(buf)
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

export async function readManifest(path: string): Promise<Manifest> {
  const lines = await readLines(path);
  if (lines.length === 0) throw new Error("Dump file is empty.");
  const m = JSON.parse(lines[0]) as Manifest;
  if (m.format !== DUMP_FORMAT && m.format !== LEGACY_DUMP_FORMAT)
    throw new Error(`Unexpected dump format: ${m.format}`);
  return m;
}

export type RestoreResult = { manifest: Manifest; inserted: Record<string, number>; total: number };

/**
 * Restore a dump into `url`. Truncates the tables the dump covers, then
 * reloads them. Constraints are deferred for the transaction so row order
 * within a table cannot trip a self-referencing foreign key.
 */
export async function restore(
  path: string,
  url: string,
  opts: {
    allowLegacyTimestamps?: boolean;
    /** Permit tables in the target that the dump does not cover. */
    allowExtraTables?: boolean;
    /** Permit column differences between the dump and the target. */
    allowColumnDrift?: boolean;
  } = {},
): Promise<RestoreResult> {
  const manifest = await readManifest(path);
  if (manifest.format === LEGACY_DUMP_FORMAT && !opts.allowLegacyTimestamps)
    throw new Error(
      `This is a ${LEGACY_DUMP_FORMAT} dump. Its naive timestamps were written as UTC by ` +
        `the machine that took it, so restoring shifts every timestamp by that machine's ` +
        `UTC offset. Take a fresh backup instead, or pass allowLegacyTimestamps if you ` +
        `genuinely accept the shift.`,
    );
  const c = await clientFor(url, "restore connection");
  const inserted: Record<string, number> = {};
  let total = 0;
  try {
    await c.query("BEGIN");
    await c.query("SET CONSTRAINTS ALL DEFERRED");

    // Children first so foreign keys never block the clear-out.
    const present = new Set(
      (
        await c.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
        )
      ).rows.map((r) => r.tablename),
    );
    const targets = manifest.tableOrder.filter((t) => present.has(t));
    const missing = manifest.tableOrder.filter((t) => !present.has(t));
    if (missing.length)
      throw new Error(
        `Target is missing ${missing.length} table(s) the dump contains (${missing.slice(0, 5).join(", ")}). Apply the schema first.`,
      );

    // TRUNCATE ... CASCADE follows foreign keys into tables the dump knows
    // nothing about, and the row-count check afterwards only looks at tables
    // the dump does mention — so a table could be emptied without a single
    // line of output anywhere. Refuse instead.
    const dumped = new Set(manifest.tableOrder);
    const extra = [...present].filter((t) => !dumped.has(t)).sort();
    if (extra.length && !opts.allowExtraTables)
      throw new Error(
        `Target has ${extra.length} table(s) the dump does not cover (${extra.slice(0, 8).join(", ")}). ` +
          `TRUNCATE CASCADE could empty them silently. Use a dump of this schema, ` +
          `or pass allowExtraTables if you have confirmed they are expendable.`,
      );

    // A column present in the target but absent from the dump takes its default
    // or NULL on every restored row. Row counts accept that, and so does a
    // digest computed over the columns both sides share, so check it here.
    const targetCols = await c.query<{ t: string; col: string }>(
      `SELECT table_name AS t, column_name AS col FROM information_schema.columns
        WHERE table_schema = 'public'`,
    );
    const byTable = new Map<string, Set<string>>();
    for (const r of targetCols.rows) {
      if (!byTable.has(r.t)) byTable.set(r.t, new Set());
      byTable.get(r.t)!.add(r.col);
    }
    const columnProblems: string[] = [];
    for (const t of targets) {
      const dumpCols = new Set(Object.keys(manifest.columnTypes?.[t] ?? {}));
      const haveCols = byTable.get(t) ?? new Set<string>();
      const onlyTarget = [...haveCols].filter((k) => !dumpCols.has(k));
      const onlyDump = [...dumpCols].filter((k) => !haveCols.has(k));
      if (onlyTarget.length) columnProblems.push(`${t}: target has ${onlyTarget.join(", ")} — the dump has no values for them`);
      if (onlyDump.length) columnProblems.push(`${t}: target is missing ${onlyDump.join(", ")}`);
    }
    if (columnProblems.length && !opts.allowColumnDrift)
      throw new Error(
        ["Schema drift between the dump and the target:", ...columnProblems.slice(0, 10)].join(
          "\n  ",
        ),
      );

    if (targets.length)
      await c.query(`TRUNCATE ${targets.map((t) => `"${t}"`).join(", ")} CASCADE`);

    const lines = await readLines(path);
    let first = true;
    // Batch inserts per table to keep round trips down without buffering the
    // whole table in memory.
    let batchTable = "";
    let batchCols: string[] = [];
    let batchRows: unknown[][] = [];

    const flush = async () => {
      if (!batchRows.length) return;
      const colList = batchCols.map((k) => `"${k}"`).join(", ");
      const params: unknown[] = [];
      const tuples = batchRows.map((vals) => {
        const ph = vals.map((v) => {
          params.push(v);
          return `$${params.length}`;
        });
        return `(${ph.join(", ")})`;
      });
      await c.query(
        `INSERT INTO "${batchTable}" (${colList}) VALUES ${tuples.join(", ")}`,
        params,
      );
      inserted[batchTable] = (inserted[batchTable] ?? 0) + batchRows.length;
      total += batchRows.length;
      batchRows = [];
    };

    for (const line of lines) {
      if (first) {
        first = false;
        continue; // manifest
      }
      if (!line.trim()) continue;
      const { t, r } = JSON.parse(line) as { t: string; r: Record<string, unknown> };
      const cols = Object.keys(r);
      const sameShape = t === batchTable && cols.length === batchCols.length && cols.every((k, i) => k === batchCols[i]);
      if (!sameShape) {
        await flush();
        batchTable = t;
        batchCols = cols;
      }
      const types = manifest.columnTypes?.[t] ?? {};
      batchRows.push(cols.map((k) => decodeValue(r[k], types[k])));
      if (batchRows.length >= 200) await flush();
    }
    await flush();

    await c.query("COMMIT");

    // A bulk load leaves no planner statistics, so the first queries against a
    // freshly restored database can sequential-scan and get blamed on the new
    // server being slow.
    await c.query("ANALYZE");

    for (const t of manifest.tableOrder) if (!(t in inserted)) inserted[t] = 0;
    return { manifest, inserted, total };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}
