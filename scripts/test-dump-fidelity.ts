/**
 * Round-trip fidelity tests for the dump format, against values chosen to break it.
 *
 *   npx tsx --env-file=.env scripts/test-dump-fidelity.ts
 *
 * The eight-hour timestamp shift was not found by reasoning about the code, it
 * was found by comparing a restore against its source. These are the values
 * that would have found it immediately, plus the ones most likely to cause the
 * next such bug:
 *
 *   - naive timestamps (the original bug: local-vs-UTC on the way out)
 *   - a jsonb integer beyond 2^53, which JSON.parse cannot hold exactly
 *   - jsonb 1.0, which JSON.parse turns into 1
 *   - jsonb key order and whitespace, which json preserves and jsonb does not
 *   - text containing 0x1F, the MARC subfield delimiter, which a digest that
 *     joined columns with 0x1F would have hashed ambiguously
 *   - NULL against empty string, which a NULL-dropping concat would conflate
 *   - text with newlines, quotes, backslashes and a NUL-adjacent escape
 *   - arrays, including an array containing an empty string and a NULL
 *   - numeric trailing zeros, where 1.50 and 1.5 are the same number and
 *     different text
 *
 * Nothing here touches the application schema: it builds its own table on two
 * throwaway databases. Read only against the live database (it borrows the
 * server, not the data).
 */
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { backup, restore, connectionString, describeTarget, clientFor } from "./lib/dump";
import { compareDatabases } from "./lib/db-compare";

const TABLE = "t_fidelity";

const DDL = `
CREATE TABLE "${TABLE}" (
  id            text PRIMARY KEY,
  naive_ts      timestamp(3),
  full_ts       timestamptz,
  a_date        date,
  j             jsonb,
  jt            json,
  txt           text,
  txt_null      text,
  nums          numeric,
  tags          text[],
  counts        integer[],
  big           bigint,
  flag          boolean
)`;

/** chr(31) is the ISO 2709 subfield delimiter. */
const ROWS = `
INSERT INTO "${TABLE}" VALUES
  ('r1', '2026-08-09 08:59:08.954', '2026-08-09 08:59:08.954+08',  '2026-08-09',
   '{"n": 9007199254740993, "z": 1.0, "b": [1,2,3]}'::jsonb,
   '{"b" : 2,   "a":1}'::json,
   'plain', NULL, 1.50, ARRAY['a','b'], ARRAY[1,2], 9223372036854775807, true),

  ('r2', '2026-12-31 23:59:59.999', '2026-01-01 00:00:00+00', '0001-01-01',
   '{"deep": {"x": [{"y": 0.1}]}}'::jsonb,
   '[]'::json,
   E'has\\ttab and\\nnewline and "quotes" and \\\\backslash', '', 0.0,
   ARRAY['', NULL], ARRAY[]::integer[], -9223372036854775808, false),

  ('r3', NULL, NULL, NULL, NULL, NULL,
   E'marc\\x1fdelimited\\x1ffields', 'not null', NULL,
   ARRAY['a' || chr(31) || 'b'], NULL, NULL, NULL)
`;

function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

void (async () => {
  const live = connectionString();
  const stamp = Date.now().toString(36);
  const dbA = `dls_fid_a_${stamp}`;
  const dbB = `dls_fid_b_${stamp}`;
  const workDir = resolve(tmpdir(), `dls-fid-${stamp}`);
  mkdirSync(workDir, { recursive: true });
  const dumpPath = resolve(workDir, "fid.ndjson.gz");

  console.log(`Fidelity tests on ${describeTarget(live)} (own tables, live data untouched)`);

  const admin = new Client({ connectionString: withDatabase(live, "postgres") });
  admin.on("error", () => {});
  await admin.connect();

  try {
    for (const db of [dbA, dbB]) await admin.query(`CREATE DATABASE "${db}"`);
    const urlA = withDatabase(live, dbA);
    const urlB = withDatabase(live, dbB);

    // Source: build the table and load the awkward rows.
    const a = await clientFor(urlA, "source");
    await a.query(DDL);
    await a.query(ROWS);

    // Target: same DDL, no rows.
    const b = await clientFor(urlB, "target");
    await b.query(DDL);

    console.log("\n1. Dump and restore");
    const { manifest } = await backup(dumpPath, urlA);
    check(manifest.rowCounts[TABLE] === 3, "dump captured all 3 rows", `${manifest.rowCounts[TABLE]}`);
    const res = await restore(dumpPath, urlB);
    check(res.inserted[TABLE] === 3, "restore inserted all 3 rows", `${res.inserted[TABLE]}`);

    console.log("\n2. Full comparison");
    const cmp = await compareDatabases({ label: "src", url: urlA }, { label: "dst", url: urlB });
    const blocking = cmp.differences.filter((d) => d.blocking);
    check(cmp.digestsCompared, "digests were compared");
    check(
      blocking.length === 0,
      "no blocking differences",
      blocking.map((d) => `${d.kind}:${d.subject}`).join(", "),
    );

    console.log("\n3. Value-by-value, the ones that break naive encodings");
    // Compare the server's own text for each column, which is the only
    // rendering that cannot be argued with.
    const cols = [
      "naive_ts",
      "full_ts",
      "a_date",
      "j",
      "jt",
      "txt",
      "txt_null",
      "nums",
      "tags",
      "counts",
      "big",
      "flag",
    ];
    for (const col of cols) {
      const q = `SELECT id, coalesce(octet_length("${col}"::text)::text || ':' || "${col}"::text, 'NULL') AS v
                   FROM "${TABLE}" ORDER BY id`;
      const [ra, rb] = [await a.query<{ id: string; v: string }>(q), await b.query<{ id: string; v: string }>(q)];
      const bad = ra.rows.filter((r, i) => r.v !== rb.rows[i]?.v);
      check(
        bad.length === 0,
        `${col} identical on all rows`,
        bad.map((r) => `${r.id}: ${r.v} vs ${rb.rows.find((x) => x.id === r.id)?.v}`).join(" | "),
      );
    }

    console.log("\n4. Named regressions");
    const one = async (c: Client, sql: string) => (await c.query<{ v: string }>(sql)).rows[0]?.v;

    // The original bug: a naive timestamp must come back as the same wall clock.
    const tsSql = `SELECT naive_ts::text AS v FROM "${TABLE}" WHERE id = 'r1'`;
    check(
      (await one(a, tsSql)) === "2026-08-09 08:59:08.954" &&
        (await one(b, tsSql)) === "2026-08-09 08:59:08.954",
      "naive timestamp did not shift",
      `${await one(a, tsSql)} vs ${await one(b, tsSql)}`,
    );

    // An integer JSON.parse cannot represent exactly.
    const bigSql = `SELECT j->>'n' AS v FROM "${TABLE}" WHERE id = 'r1'`;
    check(
      (await one(b, bigSql)) === "9007199254740993",
      "jsonb integer past 2^53 survived",
      `${await one(b, bigSql)}`,
    );

    // jsonb normalises 1.0, but it must normalise the same way on both sides.
    const zSql = `SELECT j->>'z' AS v FROM "${TABLE}" WHERE id = 'r1'`;
    check((await one(a, zSql)) === (await one(b, zSql)), "jsonb 1.0 round-tripped consistently", `${await one(a, zSql)} vs ${await one(b, zSql)}`);

    // json (not jsonb) preserves the source text verbatim, whitespace included.
    const jtSql = `SELECT jt::text AS v FROM "${TABLE}" WHERE id = 'r1'`;
    check(
      (await one(a, jtSql)) === (await one(b, jtSql)),
      "json kept its original spacing and key order",
      `${await one(a, jtSql)} vs ${await one(b, jtSql)}`,
    );

    // NULL and empty string must stay distinguishable.
    const nullSql = `SELECT count(*)::text AS v FROM "${TABLE}" WHERE txt_null IS NULL`;
    const emptySql = `SELECT count(*)::text AS v FROM "${TABLE}" WHERE txt_null = ''`;
    check(
      (await one(b, nullSql)) === "1" && (await one(b, emptySql)) === "1",
      "NULL and empty string stayed distinct",
      `nulls=${await one(b, nullSql)} empties=${await one(b, emptySql)}`,
    );

    // The MARC subfield delimiter inside a text value.
    const marcSql = `SELECT octet_length(txt)::text AS v FROM "${TABLE}" WHERE id = 'r3'`;
    check(
      (await one(a, marcSql)) === (await one(b, marcSql)),
      "text containing 0x1F survived byte for byte",
      `${await one(a, marcSql)} vs ${await one(b, marcSql)}`,
    );

    // numeric scale is part of the value's text form.
    const numSql = `SELECT nums::text AS v FROM "${TABLE}" WHERE id = 'r1'`;
    check((await one(b, numSql)) === "1.50", "numeric kept its trailing zero", `${await one(b, numSql)}`);

    console.log("\n5. Guards refuse an unsafe restore");
    // A table the dump does not cover would be caught by TRUNCATE ... CASCADE.
    await b.query(`CREATE TABLE t_extra (id text PRIMARY KEY, ref text REFERENCES "${TABLE}"(id))`);
    let refused = false;
    try {
      await restore(dumpPath, urlB);
    } catch (e) {
      refused = /does not cover/.test((e as Error).message);
    }
    check(refused, "refuses when the target has a table the dump does not cover");
    await b.query(`DROP TABLE t_extra`);

    // A column the dump has no values for would silently take its default.
    await b.query(`ALTER TABLE "${TABLE}" ADD COLUMN surprise text DEFAULT 'x'`);
    refused = false;
    try {
      await restore(dumpPath, urlB);
    } catch (e) {
      refused = /Schema drift/.test((e as Error).message);
    }
    check(refused, "refuses when the target has a column the dump does not");

    await a.end();
    await b.end();
  } finally {
    for (const db of [dbA, dbB])
      await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => {});
    await admin.end();
    rmSync(workDir, { recursive: true, force: true });
  }

  console.log(
    failures === 0
      ? "\nALL PASSED — the dump round-trips every awkward value tested."
      : `\nFAILED — ${failures} check(s) did not pass.`,
  );
  process.exit(failures === 0 ? 0 : 1);
})();
