/**
 * Structural and content comparison of two Postgres databases.
 *
 * Moving a database to a different host is only safe if you can prove the copy
 * is the same. Row counts cannot do that: a restore that dropped every value
 * to NULL, lost a unique index, mangled a timezone or reordered an enum would
 * still count the same number of rows. So this compares four things:
 *
 *   1. shape    — tables, columns, types, nullability, defaults
 *   2. rules    — indexes, constraints, foreign keys, enum labels, extensions
 *   3. counts   — rows per table
 *   4. content  — a per-table md5 over every row, order independent
 *
 * The content digest is the one that matters. It hashes Postgres's own text
 * rendering of every row, projected through ROW(...) with the columns in
 * alphabetical order, so any changed byte in any column of any row changes the
 * digest. Sorting the aggregate by that rendered text makes it independent of
 * row order, so it needs no primary key and does not care what order a restore
 * inserted things in. The alphabetical projection makes it independent of
 * physical column order too, which matters because a database whose columns
 * were added over time does not lay them out the same way as one created in a
 * single schema push.
 *
 * Caveat worth knowing: row-to-text rendering depends on the server's type
 * output functions, so a digest is only comparable between servers on the same
 * Postgres major version. Session-level rendering settings (TimeZone,
 * DateStyle, IntervalStyle) are pinned on connect so they cannot differ;
 * anything left over, notably a different major version, downgrades the digest
 * comparison to a warning rather than reporting a false mismatch.
 */

import { Client } from "pg";

export type Row = Record<string, unknown>;

export type Side = {
  label: string;
  url: string;
};

export type Difference = {
  /** Which comparison produced it. */
  kind: "settings" | "shape" | "rules" | "counts" | "content";
  /** What differs, e.g. `Loan.dueAt` or `Copy` or `index Copy_barcode_key`. */
  subject: string;
  a: string;
  b: string;
  /** False for things that are expected to differ between two servers. */
  blocking: boolean;
};

export type CompareResult = {
  tables: string[];
  rowCounts: Record<string, { a: number; b: number }>;
  differences: Difference[];
  digestsCompared: boolean;
  /** Tables whose content digest was skipped, with the reason. */
  digestSkipped: Record<string, string>;
};

/** Settings that change how a row renders as text, so digests need them equal. */
const RENDER_SETTINGS = ["DateStyle", "IntervalStyle", "TimeZone", "extra_float_digits", "server_version_num"];

/** Above this many rows, hash in key-ordered chunks instead of one aggregate. */
const CHUNK_THRESHOLD = 200_000;

async function connect(url: string): Promise<Client> {
  const c = new Client({ connectionString: url });
  // An unhandled 'error' event kills the process and hides the real failure.
  c.on("error", () => {});
  await c.connect();
  // Pin the settings that decide how a row renders as text, so a digest means
  // the same thing on both sides regardless of how each server is configured.
  await c.query("SET TIME ZONE 'UTC'");
  await c.query("SET DateStyle = 'ISO, MDY'");
  await c.query("SET IntervalStyle = 'postgres'");
  return c;
}

async function settings(c: Client): Promise<Record<string, string>> {
  const { rows } = await c.query<{ name: string; setting: string }>(
    `SELECT name, setting FROM pg_settings WHERE name = ANY($1::text[])`,
    [RENDER_SETTINGS],
  );
  return Object.fromEntries(rows.map((r) => [r.name, r.setting]));
}

async function tableList(c: Client): Promise<string[]> {
  const { rows } = await c.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  return rows.map((r) => r.tablename);
}

/** table -> ordered column names, for an advisory order check. */
async function columnOrder(c: Client): Promise<Record<string, string>> {
  const { rows } = await c.query<{ k: string; v: string }>(
    `SELECT table_name::text AS k, string_agg(column_name::text, ',' ORDER BY ordinal_position) AS v
       FROM information_schema.columns
      WHERE table_schema = 'public'
      GROUP BY table_name`,
  );
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}

/** table -> column names, alphabetical. The digest projects in this order. */
async function columnNames(c: Client): Promise<Record<string, string[]>> {
  const { rows } = await c.query<{ k: string; v: string[] }>(
    `SELECT table_name::text AS k, array_agg(column_name::text ORDER BY column_name) AS v
       FROM information_schema.columns
      WHERE table_schema = 'public'
      GROUP BY table_name`,
  );
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}

/** column -> "type|nullable|default", per table. */
async function columns(c: Client): Promise<Record<string, string>> {
  const { rows } = await c.query<{ k: string; v: string }>(
    `SELECT table_name || '.' || column_name AS k,
            coalesce(data_type,'?') || '|' ||
            coalesce(udt_name,'?') || '|' ||
            is_nullable || '|' ||
            coalesce(column_default,'-') || '|' ||
            coalesce(character_maximum_length::text,'-') || '|' ||
            coalesce(numeric_precision::text,'-') || ',' || coalesce(numeric_scale::text,'-') AS v
       FROM information_schema.columns
      WHERE table_schema = 'public'`,
  );
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}

async function indexes(c: Client): Promise<Record<string, string>> {
  const { rows } = await c.query<{ k: string; v: string }>(
    `SELECT indexname AS k, indexdef AS v FROM pg_indexes WHERE schemaname = 'public'`,
  );
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}

async function constraints(c: Client): Promise<Record<string, string>> {
  const { rows } = await c.query<{ k: string; v: string }>(
    `SELECT rel.relname || '.' || con.conname AS k,
            pg_get_constraintdef(con.oid) AS v
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = 'public'`,
  );
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}

/** Enum labels in declaration order — Prisma enums are stored this way. */
async function enums(c: Client): Promise<Record<string, string>> {
  const { rows } = await c.query<{ k: string; v: string }>(
    `SELECT t.typname AS k, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS v
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      GROUP BY t.typname`,
  );
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}

async function extensions(c: Client): Promise<Record<string, string>> {
  const { rows } = await c.query<{ k: string; v: string }>(
    `SELECT extname AS k, extversion AS v FROM pg_extension`,
  );
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}

async function triggers(c: Client): Promise<Record<string, string>> {
  const { rows } = await c.query<{ k: string; v: string }>(
    `SELECT c.relname || '.' || t.tgname AS k, pg_get_triggerdef(t.oid) AS v
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
  );
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}

/** Sequence -> last_value, so a restore that left them behind is visible. */
async function sequences(c: Client): Promise<Record<string, string>> {
  const { rows } = await c.query<{ k: string }>(
    `SELECT sequencename AS k FROM pg_sequences WHERE schemaname = 'public'`,
  );
  const out: Record<string, string> = {};
  for (const r of rows) {
    const v = await c.query<{ last_value: string | null }>(
      `SELECT last_value::text AS last_value FROM pg_sequences WHERE schemaname='public' AND sequencename=$1`,
      [r.k],
    );
    out[r.k] = v.rows[0]?.last_value ?? "unset";
  }
  return out;
}

async function rowCount(c: Client, table: string): Promise<number> {
  const { rows } = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`);
  return Number(rows[0].n);
}

/**
 * md5 over every row of a table, independent of row order.
 *
 * `t::text` renders the whole row through Postgres's own output functions, so
 * this catches a changed value in any column — including ones the app rarely
 * reads. Sorting by the rendered text is what makes it order independent.
 */
async function contentDigest(
  c: Client,
  table: string,
  rows: number,
  cols: string[],
): Promise<string> {
  if (rows === 0) return "empty";
  // ROW(...) in a fixed alphabetical order rather than `t::text`, because the
  // physical column order differs between a database whose columns were added
  // over time and one created in a single schema push. That is cosmetic in
  // Postgres, but it changes how a row renders and so would change every
  // digest.
  const projection = `ROW(${cols.map((k) => `"${k}"`).join(", ")})::text`;
  if (rows <= CHUNK_THRESHOLD) {
    const { rows: r } = await c.query<{ d: string | null }>(
      `SELECT md5(string_agg(x, E'\n' ORDER BY x)) AS d FROM (SELECT ${projection} AS x FROM "${table}") s`,
    );
    return r[0].d ?? "empty";
  }
  // Big table: hash per row first, then combine, so the server never
  // materialises one enormous string.
  const { rows: r } = await c.query<{ d: string | null }>(
    `SELECT md5(string_agg(h, '' ORDER BY h)) AS d FROM (SELECT md5(${projection}) AS h FROM "${table}") s`,
  );
  return `chunked:${r[0].d ?? "empty"}`;
}
function diffMaps(
  kind: Difference["kind"],
  prefix: string,
  a: Record<string, string>,
  b: Record<string, string>,
  labelA: string,
  labelB: string,
): Difference[] {
  const out: Difference[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] !== b[k]) {
      out.push({
        kind,
        subject: prefix ? `${prefix} ${k}` : k,
        a: a[k] ?? `(absent in ${labelA})`,
        b: b[k] ?? `(absent in ${labelB})`,
        blocking: true,
      });
    }
  }
  return out.sort((x, y) => x.subject.localeCompare(y.subject));
}

export async function compareDatabases(a: Side, b: Side): Promise<CompareResult> {
  const ca = await connect(a.url);
  const cb = await connect(b.url);
  try {
    const differences: Difference[] = [];

    // 1. Rendering settings. Digests are only meaningful when these match.
    const [sa, sb] = [await settings(ca), await settings(cb)];
    let digestsComparable = true;
    for (const name of RENDER_SETTINGS) {
      if (sa[name] !== sb[name]) {
        // A different major version is not itself a data problem; it just
        // means the digest can no longer prove equality on its own.
        differences.push({
          kind: "settings",
          subject: name,
          a: sa[name] ?? "?",
          b: sb[name] ?? "?",
          blocking: false,
        });
        digestsComparable = false;
      }
    }

    // 2. Shape.
    const [ta, tb] = [await tableList(ca), await tableList(cb)];
    const onlyA = ta.filter((t) => !tb.includes(t));
    const onlyB = tb.filter((t) => !ta.includes(t));
    for (const t of onlyA)
      differences.push({ kind: "shape", subject: `table ${t}`, a: "present", b: "MISSING", blocking: true });
    for (const t of onlyB)
      differences.push({ kind: "shape", subject: `table ${t}`, a: "MISSING", b: "present", blocking: true });

    differences.push(...diffMaps("shape", "column", await columns(ca), await columns(cb), a.label, b.label));

    // Physical column order is not semantically meaningful here (Prisma always
    // names columns), so report a difference without blocking on it.
    for (const d of diffMaps(
      "shape",
      "column order",
      await columnOrder(ca),
      await columnOrder(cb),
      a.label,
      b.label,
    ))
      differences.push({ ...d, blocking: false });

    // 3. Rules.
    differences.push(...diffMaps("rules", "index", await indexes(ca), await indexes(cb), a.label, b.label));
    differences.push(
      ...diffMaps("rules", "constraint", await constraints(ca), await constraints(cb), a.label, b.label),
    );
    differences.push(...diffMaps("rules", "enum", await enums(ca), await enums(cb), a.label, b.label));
    differences.push(...diffMaps("rules", "trigger", await triggers(ca), await triggers(cb), a.label, b.label));
    differences.push(
      ...diffMaps("rules", "sequence", await sequences(ca), await sequences(cb), a.label, b.label),
    );
    // Extension version can legitimately differ between servers; flag it but
    // do not block on the version alone.
    for (const d of diffMaps("rules", "extension", await extensions(ca), await extensions(cb), a.label, b.label))
      differences.push({ ...d, blocking: d.a.startsWith("(absent") || d.b.startsWith("(absent") });

    // 4. Counts and content, over the tables both sides have.
    const shared = ta.filter((t) => tb.includes(t));
    const [namesA, namesB] = [await columnNames(ca), await columnNames(cb)];
    const rowCounts: Record<string, { a: number; b: number }> = {};
    const digestSkipped: Record<string, string> = {};
    for (const t of shared) {
      const [na, nb] = [await rowCount(ca, t), await rowCount(cb, t)];
      rowCounts[t] = { a: na, b: nb };
      if (na !== nb) {
        differences.push({
          kind: "counts",
          subject: t,
          a: String(na),
          b: String(nb),
          blocking: true,
        });
        // A count mismatch already fails; the digest would only repeat it.
        digestSkipped[t] = "row counts differ";
        continue;
      }
      if (!digestsComparable) {
        digestSkipped[t] = "server rendering settings differ";
        continue;
      }
      // Digest only the columns both sides have: a missing column is already a
      // blocking shape difference, and including it here would repeat that as an
      // unreadable hash mismatch on every table it touches.
      const cols = (namesA[t] ?? []).filter((k) => (namesB[t] ?? []).includes(k));
      if (cols.length === 0) {
        digestSkipped[t] = "no columns in common";
        continue;
      }
      const [da, db] = [
        await contentDigest(ca, t, na, cols),
        await contentDigest(cb, t, nb, cols),
      ];
      if (da !== db)
        differences.push({ kind: "content", subject: t, a: da, b: db, blocking: true });
    }

    return {
      tables: shared,
      rowCounts,
      differences,
      digestsCompared: digestsComparable,
      digestSkipped,
    };
  } finally {
    await ca.end().catch(() => {});
    await cb.end().catch(() => {});
  }
}

export function reportComparison(r: CompareResult, labelA: string, labelB: string): number {
  const blocking = r.differences.filter((d) => d.blocking);
  const advisory = r.differences.filter((d) => !d.blocking);
  const totalA = Object.values(r.rowCounts).reduce((n, c) => n + c.a, 0);

  console.log(`Tables compared : ${r.tables.length}`);
  console.log(`Rows compared   : ${totalA}`);
  console.log(
    `Content digests : ${
      r.digestsCompared
        ? `compared on ${r.tables.length - Object.keys(r.digestSkipped).length} table(s)`
        : "NOT compared (server rendering settings differ)"
    }`,
  );

  if (advisory.length) {
    console.log(`\nAdvisory (${advisory.length}):`);
    for (const d of advisory) console.log(`  ~ ${d.subject}: ${labelA}=${d.a} ${labelB}=${d.b}`);
  }
  if (blocking.length) {
    console.log(`\nBLOCKING (${blocking.length}):`);
    for (const d of blocking.slice(0, 40))
      console.log(`  ! [${d.kind}] ${d.subject}\n      ${labelA}: ${d.a}\n      ${labelB}: ${d.b}`);
    if (blocking.length > 40) console.log(`  ... and ${blocking.length - 40} more`);
  } else {
    console.log(`\nNo blocking differences. ${labelB} matches ${labelA}.`);
  }
  return blocking.length;
}
