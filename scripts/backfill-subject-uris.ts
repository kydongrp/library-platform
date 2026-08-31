/**
 * Give every subject heading in the catalogue its authority link.
 *
 *   npx tsx --env-file=.env.development.local scripts/backfill-subject-uris.ts
 *   npx tsx --env-file=.env scripts/backfill-subject-uris.ts --apply
 *
 * A MARC 650 whose $a is a bare string is a local assertion. The same heading
 * with $0 carrying an id.loc.gov URI says which concept it means, and that is
 * the difference between a record another library can reconcile and one it can
 * only read. 283 of the catalogue's 284 650 fields carry the URI because
 * apply-subject-headings.ts wrote them that way; one predates it.
 *
 * This is deliberately NOT apply-subject-headings.ts. That script adds headings
 * a record does not have, and treats a heading already present as nothing to
 * do, which is exactly the case here: the heading is present and it is the
 * SUBFIELD that is missing. So this patches existing fields in place and adds
 * nothing new.
 *
 * The heading is re-resolved against id.loc.gov and must come back as an
 * authorised heading with the label byte-identical to what is already in $a.
 * Anything else is reported and left alone: writing a URI that names a
 * different concept than the text beside it would make the record contradict
 * itself, which is worse than the missing link it set out to fix.
 *
 * Dry by default. Idempotent: a field that already has an id.loc.gov $0 is
 * never considered, so a second run finds nothing.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { resolveSubject } from "../src/lib/lcsh";

const APPLY = process.argv.includes("--apply");
const ACTOR = "script:backfill-subject-uris";

type Subfield = { code: string; value: string };

type Row = {
  id: string;
  subfields: Subfield[];
  title: string;
  category: string | null;
};

void (async () => {
  const c = new Client({ connectionString: process.env.POSTGRES_URL_NON_POOLING! });
  await c.connect();
  const db = (await c.query<{ d: string }>(`SELECT current_database() AS d`)).rows[0].d;
  console.log(`database: ${db}`);
  console.log(APPLY ? "MODE: apply\n" : "MODE: dry run, nothing will be written\n");

  const all = await c.query<Row>(
    `SELECT m.id, m.subfields, r.title, r.category
       FROM "MarcField" m
       JOIN "Resource" r ON r.id = m."resourceId"
      WHERE m.tag = '650'
      ORDER BY r.title`,
  );

  // A $0 that is not an id.loc.gov URI is not the authority link this is about,
  // so the test is on the value and not merely on the subfield being present.
  const needing = all.rows.filter(
    (m) =>
      !(m.subfields ?? []).some(
        (s) => s.code === "0" && typeof s.value === "string" && s.value.includes("id.loc.gov"),
      ),
  );

  console.log(`${all.rows.length} subject headings in the catalogue.`);
  console.log(`${needing.length} without an id.loc.gov authority link.\n`);
  if (needing.length === 0) {
    console.log("Nothing to do.");
    await c.end();
    return;
  }

  const subjType = await c.query<{ id: string }>(
    `SELECT id FROM "AuthorityType" WHERE code = 'SUBJ' LIMIT 1`,
  );
  if (!subjType.rows.length) {
    console.error("No AuthorityType with code SUBJ. Create it before running this.");
    process.exit(1);
  }
  const typeId = subjType.rows[0].id;

  let patched = 0;
  let authoritiesAdded = 0;
  const refused: { heading: string; title: string; why: string }[] = [];

  for (const field of needing) {
    const subs = field.subfields ?? [];
    const a = subs.find((s) => s.code === "a");
    const heading = (a?.value ?? "").trim();
    console.log(`${field.title.slice(0, 58)}  [${field.category ?? "-"}]`);
    if (!heading) {
      console.log(`  REFUSED  the field has no $a to resolve\n`);
      refused.push({ heading: "(none)", title: field.title, why: "no $a" });
      continue;
    }

    const hit = await resolveSubject(heading);
    await new Promise((r) => setTimeout(r, 130));

    if (!hit) {
      // resolveSubject retries internally and returns null both for an absent
      // heading and for a lookup it could not finish, so this says neither.
      const why = "could not establish an authorised LCSH heading (absent, or the lookup failed)";
      console.log(`  REFUSED  ${heading}\n             ${why}\n`);
      refused.push({ heading, title: field.title, why });
      continue;
    }
    if (!hit.exact || hit.label !== heading) {
      const why = hit.exact
        ? `LCSH authorises "${hit.label}", not this`
        : `no authorised heading with this exact label; nearest offer was "${hit.label}", which may be a different concept`;
      console.log(`  REFUSED  ${heading}\n             ${why}\n`);
      refused.push({ heading, title: field.title, why });
      continue;
    }

    console.log(`  ok       ${heading}  [${hit.token}]`);

    // The authority record the 650 points at, if the catalogue lacks it.
    const existing = await c.query(
      `SELECT id FROM "Authority" WHERE "typeId" = $1 AND heading = $2`,
      [typeId, heading],
    );
    if (!existing.rows.length) {
      console.log(`  + authority  ${heading}`);
      if (APPLY) {
        await c.query(
          `INSERT INTO "Authority" (id, "typeId", heading, "seeAlso", uri, note)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            randomUUID(),
            typeId,
            heading,
            hit.variants.length ? hit.variants.join(" · ") : null,
            hit.uri,
            `LCSH ${hit.token}`,
          ],
        );
      }
      authoritiesAdded++;
    }

    // $0 appended, existing subfields untouched and in order. Matches how
    // apply-subject-headings.ts writes a new field: $a first, $0 last.
    const next: Subfield[] = [...subs.filter((s) => s.code !== "0"), { code: "0", value: hit.uri }];
    console.log(`  + $0  ${hit.uri}\n`);
    if (APPLY) {
      await c.query(
        `UPDATE "MarcField" SET subfields = $2::jsonb, "updatedAt" = now() WHERE id = $1`,
        [field.id, JSON.stringify(next)],
      );
    }
    patched++;
  }

  if (APPLY && patched > 0) {
    await c.query(
      `INSERT INTO "AuditLog" (id, actor, action, entity, summary, detail)
       VALUES ($1, $2, 'marc.backfillSubjectUri', 'MarcField', $3, $4)`,
      [
        randomUUID(),
        ACTOR,
        `Added an LCSH authority URI to ${patched} subject heading(s) that had none`,
        JSON.stringify({
          patched,
          authoritiesAdded,
          refused,
          source: "id.loc.gov authorities/subjects",
          note: "each heading re-resolved and required to match the existing $a byte for byte",
        }),
      ],
    );
  }

  console.log(
    `${APPLY ? "Written" : "Would write"}: $0 on ${patched} field(s), ` +
      `${authoritiesAdded} new authority record(s). ${refused.length} refused.`,
  );
  if (refused.length) {
    console.log(`\nRefused, and left exactly as they were (${refused.length}):`);
    for (const r of refused) console.log(`  ${r.heading} on "${r.title.slice(0, 50)}": ${r.why}`);
  }
  if (!APPLY) console.log("\nDry run. Re-run with --apply to write.");
  await c.end();
})();
