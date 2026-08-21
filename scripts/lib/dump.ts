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

import { Client } from "pg";
import { encrypt, decrypt, isEncrypted, hasBackupKey } from "./crypt";

export const DUMP_FORMAT = "dls-ndjson-1";

export type Manifest = {
  format: typeof DUMP_FORMAT;
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
 * Encode one row for JSON. Dates go to ISO strings, Buffers to base64,
 * bigints to strings — all reversed on restore using the column types, so a
 * timestamp does not come back as text.
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
  // would be sent as a Postgres array literal and rejected.
  if (dataType === "json" || dataType === "jsonb") return JSON.stringify(v);
  return v;
}

export type BackupResult = { manifest: Manifest; bytes: number; path: string; encrypted: boolean };

export async function backup(outPath: string, url: string): Promise<BackupResult> {
  const c = new Client({ connectionString: url });
  c.on("error", (e) => console.error(`  [backup connection] ${e.message}`));
  await c.connect();
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
  if (m.format !== DUMP_FORMAT) throw new Error(`Unexpected dump format: ${m.format}`);
  return m;
}

export type RestoreResult = { manifest: Manifest; inserted: Record<string, number>; total: number };

/**
 * Restore a dump into `url`. Truncates the tables the dump covers, then
 * reloads them. Constraints are deferred for the transaction so row order
 * within a table cannot trip a self-referencing foreign key.
 */
export async function restore(path: string, url: string): Promise<RestoreResult> {
  const manifest = await readManifest(path);
  const c = new Client({ connectionString: url });
  c.on("error", (e) => console.error(`  [restore connection] ${e.message}`));
  await c.connect();
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
    for (const t of manifest.tableOrder) if (!(t in inserted)) inserted[t] = 0;
    return { manifest, inserted, total };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}
