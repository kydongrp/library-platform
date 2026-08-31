/**
 * Give the catalogue subject access it never had.
 *
 *   npx tsx --env-file=.env.development.local scripts/apply-subject-headings.ts <file>
 *   npx tsx --env-file=.env scripts/apply-subject-headings.ts <file> --apply
 *
 * Every MARC 650 in this catalogue was empty, there were no authority records,
 * and 40 of 62 titles sat under one category, "Technology". Subject access was
 * whatever a keyword search could scrape out of a title.
 *
 * The input is a classification: which concepts each record is about. This
 * script does not trust it. Every heading is re-resolved against id.loc.gov
 * here, and one that does not come back as an authorised LCSH heading with the
 * exact label proposed is refused and reported, never written. A classification
 * step that invents a plausible-looking heading and a URI to match is the
 * expected failure mode, and the only defence is checking rather than believing.
 *
 * What it writes, per accepted heading:
 *   Authority   the controlled heading, with the LCSH URI and its "use for"
 *               variants, under the existing SUBJ type
 *   MarcField   650, ind2 = 0 (LCSH), $a the authorised label, $0 the URI
 *
 * Dry by default. Idempotent: a heading already on a record is left alone, so
 * a re-run adds only what is missing.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { resolveSubject, type LcshHeading } from "../src/lib/lcsh";

const APPLY = process.argv.includes("--apply");
const FILE = process.argv[2];
const ACTOR = "script:apply-subject-headings";

type Proposed = { label: string; uri: string; token: string; justification: string };
type Assignment = { id: string; title: string; titleOnly: boolean; subjects: Proposed[]; note: string };

if (!FILE || FILE.startsWith("--")) {
  console.error("Usage: apply-subject-headings.ts <classification.json> [--apply]");
  process.exit(1);
}

void (async () => {
  const input = JSON.parse(readFileSync(FILE, "utf8")) as { records: Assignment[] };
  const records = input.records ?? [];
  const proposed = [...new Set(records.flatMap((r) => (r.subjects ?? []).map((s) => s.label)))].sort();

  console.log(`${records.length} records, ${proposed.length} distinct headings proposed\n`);

  // ---- 1. Independent verification against the Library of Congress ---------
  console.log("Verifying every heading against id.loc.gov:");
  const verified = new Map<string, LcshHeading>();
  const refusedHeadings = new Map<string, string>();

  for (const label of proposed) {
    const hit = await resolveSubject(label);
    if (!hit) {
      // Deliberately not "LCSH has no such heading". resolveSubject returns
      // null both for a heading that does not exist and for a lookup it could
      // not complete, and it retries before giving up, so by here the honest
      // statement is that nothing was established either way. Saying more than
      // that once dropped a real heading, Sea-power--China, on one failed
      // request.
      const why = "could not establish an authorised LCSH heading (absent, or the lookup failed)";
      refusedHeadings.set(label, why);
      console.log(`  REFUSED  ${label}\n             ${why}`);
    } else if (!hit.exact || hit.label !== label) {
      // The proposed string is not the authorised form. This is the
      // Neurobiology/Computer science trap: cataloguing under the wrong sense
      // puts the record in front of the wrong reader and hides it from the
      // right one, so it is refused rather than silently corrected.
      //
      // The two cases are said differently on purpose. A non-exact hit is the
      // nearest thing the index offered and may be an unrelated concept, so
      // reporting it as what "LCSH authorises" for this term would be a
      // misstatement: "Cryptography in art" is the nearest offer for
      // "Cryptography" and is not a rewording of it.
      const why = hit.exact
        ? `LCSH authorises "${hit.label}", not this`
        : `no authorised heading with this exact label; nearest offer was "${hit.label}", which may be a different concept`;
      refusedHeadings.set(label, why);
      console.log(`  REFUSED  ${label}\n             ${why}`);
    } else {
      verified.set(label, hit);
      console.log(`  ok       ${label}  [${hit.token}]`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  console.log(`\n${verified.size} verified, ${refusedHeadings.size} refused.\n`);
  if (verified.size === 0) {
    console.log("Nothing verified; not writing.");
    process.exit(1);
  }

  // ---- 2. Apply ------------------------------------------------------------
  const c = new Client({ connectionString: process.env.POSTGRES_URL_NON_POOLING! });
  await c.connect();
  const db = (await c.query<{ d: string }>(`SELECT current_database() AS d`)).rows[0].d;
  console.log(`database: ${db}`);
  console.log(APPLY ? "MODE: apply\n" : "MODE: dry run, nothing will be written\n");

  const subjType = await c.query<{ id: string }>(
    `SELECT id FROM "AuthorityType" WHERE code = 'SUBJ' LIMIT 1`,
  );
  if (!subjType.rows.length) {
    console.error('No AuthorityType with code SUBJ. Create it before running this.');
    process.exit(1);
  }
  const typeId = subjType.rows[0].id;

  let authoritiesAdded = 0;
  let fieldsAdded = 0;
  let fieldsAlreadyThere = 0;

  // Authority records first: the 650s point at them.
  for (const [label, hit] of verified) {
    const existing = await c.query(
      `SELECT id FROM "Authority" WHERE "typeId" = $1 AND heading = $2`,
      [typeId, label],
    );
    if (existing.rows.length) continue;
    console.log(`  + authority  ${label}`);
    if (APPLY) {
      await c.query(
        `INSERT INTO "Authority" (id, "typeId", heading, "seeAlso", uri, note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          typeId,
          label,
          hit.variants.length ? hit.variants.join(" · ") : null,
          hit.uri,
          `LCSH ${hit.token}`,
        ],
      );
    }
    authoritiesAdded++;
  }

  // Then the 650s.
  for (const rec of records) {
    const usable = (rec.subjects ?? []).filter((s) => verified.has(s.label));
    if (!usable.length) continue;

    const present = await c.query<{ subfields: { code: string; value: string }[] }>(
      `SELECT subfields FROM "MarcField" WHERE "resourceId" = $1 AND tag = '650'`,
      [rec.id],
    );
    const already = new Set(
      present.rows.flatMap((r) =>
        (r.subfields ?? []).filter((s) => s.code === "a").map((s) => s.value),
      ),
    );

    const maxSeq = await c.query<{ m: number | null }>(
      `SELECT max(seq) AS m FROM "MarcField" WHERE "resourceId" = $1`,
      [rec.id],
    );
    let seq = (maxSeq.rows[0].m ?? 0) + 1;

    for (const s of usable) {
      if (already.has(s.label)) {
        fieldsAlreadyThere++;
        continue;
      }
      const hit = verified.get(s.label)!;
      if (!APPLY) console.log(`  + 650  ${rec.title.slice(0, 48).padEnd(48)}  ${s.label}`);
      if (APPLY) {
        await c.query(
          `INSERT INTO "MarcField" (id, "resourceId", tag, ind1, ind2, subfields, seq, "updatedAt")
           VALUES ($1, $2, '650', ' ', '0', $3::jsonb, $4, now())`,
          [
            randomUUID(),
            rec.id,
            JSON.stringify([
              { code: "a", value: s.label },
              { code: "0", value: hit.uri },
            ]),
            seq,
          ],
        );
      }
      seq++;
      fieldsAdded++;
    }
  }

  if (APPLY) {
    await c.query(
      `INSERT INTO "AuditLog" (id, actor, action, entity, summary, detail)
       VALUES ($1, $2, 'catalogue.subjects', 'Resource', $3, $4)`,
      [
        randomUUID(),
        ACTOR,
        `Added ${fieldsAdded} verified LCSH subject headings across ${records.length} records, and ${authoritiesAdded} authority records`,
        JSON.stringify({
          headingsVerified: verified.size,
          headingsRefused: [...refusedHeadings.entries()].map(([label, why]) => ({ label, why })),
          fieldsAdded,
          authoritiesAdded,
          source: "id.loc.gov authorities/subjects",
        }),
      ],
    );
  }

  console.log(
    `\n${APPLY ? "Written" : "Would write"}: ${authoritiesAdded} authority record(s), ` +
      `${fieldsAdded} subject heading(s). ${fieldsAlreadyThere} already present.`,
  );
  if (refusedHeadings.size) {
    console.log(`\nRefused, and NOT written (${refusedHeadings.size}):`);
    for (const [label, why] of refusedHeadings) console.log(`  ${label}: ${why}`);
  }
  if (!APPLY) console.log("\nDry run. Re-run with --apply to write.");
  await c.end();
})();
