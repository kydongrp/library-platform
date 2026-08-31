/**
 * Catalogue a verified acquisitions list.
 *
 *   npx tsx --env-file=.env scripts/add-defence-acquisitions.ts <file.json>
 *   npx tsx --env-file=.env scripts/add-defence-acquisitions.ts <file.json> --apply
 *
 * The catalogue serves a defence science organisation and held 62 titles, four
 * of them defence material. This adds curated defence acquisitions with their
 * bibliographic metadata already established, rather than through the
 * link-intake path, because intake reads whatever the page happens to say and
 * an institutional report's landing page is often a worse title than the
 * report's own.
 *
 * What it still borrows from the intake path, because those checks are not
 * about metadata quality:
 *
 *   admitUrl      a link the fetcher would refuse is not a resource. The same
 *                 SSRF guard, so a catalogue entry cannot point at private
 *                 space.
 *   canonicalise  strips tracking parameters so the duplicate check compares
 *                 the same article to itself.
 *
 * Dry by default. Idempotent: digitalUrl is @unique, and an existing link is
 * reported and skipped rather than colliding.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { admitUrl } from "../src/lib/page-fetch";
import { canonicaliseUrl } from "../src/lib/submission-core";
import { coverColorFor } from "../src/lib/ingest";
import { defaultDesignationFor, RESOURCE_TYPES } from "../src/lib/constants";

const APPLY = process.argv.includes("--apply");
const FILE = process.argv[2];
const ACTOR = "script:add-defence-acquisitions";
const CATEGORY = "Defence";

type Incoming = {
  title: string;
  authors: string;
  publisher: string;
  year: number;
  url: string;
  httpStatus: number;
  type: string;
  subjects: string[];
  whyItBelongs: string;
  domain?: string;
};

if (!FILE || FILE.startsWith("--")) {
  console.error("Usage: add-defence-acquisitions.ts <accepted.json> [--apply]");
  process.exit(1);
}

void (async () => {
  const input = JSON.parse(readFileSync(FILE, "utf8")) as { accepted: Incoming[] };
  const incoming = input.accepted ?? [];
  console.log(`${incoming.length} candidates\n`);

  const c = new Client({ connectionString: process.env.POSTGRES_URL_NON_POOLING! });
  await c.connect();
  const db = (await c.query<{ d: string }>(`SELECT current_database() AS d`)).rows[0].d;
  console.log(`database: ${db}`);
  console.log(APPLY ? "MODE: apply\n" : "MODE: dry run, nothing will be written\n");

  // The category is a managed code list, so this is a data row rather than a
  // code change. Staff can rename or remove it later without touching records.
  const catExists = await c.query(`SELECT id FROM "ResourceCategory" WHERE name = $1`, [CATEGORY]);
  if (!catExists.rows.length) {
    console.log(`+ category  ${CATEGORY}`);
    if (APPLY) {
      await c.query(`INSERT INTO "ResourceCategory" (id, name, "sortOrder") VALUES ($1, $2, $3)`, [
        randomUUID(),
        CATEGORY,
        5,
      ]);
    }
  }

  let added = 0;
  let duplicate = 0;
  let refused = 0;

  for (const r of incoming) {
    const label = r.title.slice(0, 62);

    // Refuse before cataloguing, not after. A link the fetcher will not follow
    // is not a resource that failed to load, it is not a resource.
    const admitted = admitUrl(r.url);
    if (!admitted.ok) {
      console.log(`  REFUSED  ${label}\n             ${admitted.reason}: ${r.url}`);
      refused++;
      continue;
    }

    const canonical = canonicaliseUrl(r.url);
    const existing = await c.query(
      `SELECT id, title FROM "Resource" WHERE "digitalUrl" IN ($1, $2)`,
      [canonical, r.url],
    );
    if (existing.rows.length) {
      console.log(`  already  ${label}`);
      duplicate++;
      continue;
    }

    const type = (RESOURCE_TYPES as readonly string[]).includes(r.type) ? r.type : "EBOOK";
    console.log(`  + ${type.padEnd(10)} ${label}`);
    // Counted before the dry-run bail, so the summary reports what the listing
    // above actually showed. It said "would write: 0 new" while listing two.
    added++;
    if (!APPLY) continue;

    await c.query(
      `INSERT INTO "Resource"
         (id, title, author, type, "materialDesignation", category, publisher,
          "publishedYear", language, description, "coverColor", digital,
          "digitalUrl", provider, "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'English',$9,$10,true,$11,$12, now())`,
      [
        randomUUID(),
        r.title.slice(0, 500),
        (r.authors || "Unknown").slice(0, 300),
        type,
        defaultDesignationFor(type),
        CATEGORY,
        r.publisher?.slice(0, 200) || null,
        Number.isFinite(r.year) ? r.year : null,
        r.whyItBelongs?.slice(0, 4000) || null,
        coverColorFor((r.publisher ?? "") + r.title),
        canonical,
        r.publisher?.slice(0, 80) || null,
      ],
    );
  }

  if (APPLY && added > 0) {
    await c.query(
      `INSERT INTO "AuditLog" (id, actor, action, entity, summary, detail)
       VALUES ($1, $2, 'catalogue.acquisitions', 'Resource', $3, $4)`,
      [
        randomUUID(),
        ACTOR,
        `Catalogued ${added} verified defence acquisitions under the ${CATEGORY} category`,
        JSON.stringify({
          added,
          duplicate,
          refused,
          category: CATEGORY,
          note: "every URL verified to resolve before cataloguing; see the acquisitions workflow",
        }),
      ],
    );
  }

  console.log(
    `\n${APPLY ? "Written" : "Would write"}: ${added} new. ` +
      `${duplicate} already in the catalogue, ${refused} refused.`,
  );
  if (!APPLY) console.log("Dry run. Re-run with --apply to write.");
  await c.end();
})();
