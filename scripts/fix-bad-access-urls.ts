/**
 * One-off data correction: two catalogue records with unusable access URLs.
 *
 *   npx tsx --env-file=.env.development.local scripts/fix-bad-access-urls.ts        (rehearse)
 *   npx tsx --env-file=.env scripts/fix-bad-access-urls.ts --apply                  (production)
 *
 * Found by sweeping every access URL in the catalogue after a librarian
 * reported a 404 on "Open access link". Two of the 44 were unusable:
 *
 *   1. "Attention Is All You Need" (cmsml26t5000kfsfzhp6tdii0) pointed at
 *      langtaosha.org.cn, which 404s and is not the paper. Whatever imported
 *      it attached a URL belonging to an unrelated preprint server. Repointed
 *      at arXiv, which is the open-access version of record and returns 200.
 *
 *   2. "Test" (cmsw3lkx3000204l317zivzao) pointed at test.com. Someone's
 *      scratch record, left in the live catalogue. Deleted.
 *
 * Both were verified to have no copies, loans, reservations, MARC fields or
 * Editor's Pick submissions before this was written, and the script re-checks
 * that at run time rather than trusting it: a record that has since acquired a
 * loan is not one to delete from under a borrower.
 *
 * Dry by default. Nothing is written without --apply, and every change lands
 * an AuditLog row, because a correction that leaves no trace is indistinguish-
 * able from tampering on a system whose trail is the point.
 */
import { Client } from "pg";
import { randomUUID } from "node:crypto";

const APPLY = process.argv.includes("--apply");
const ACTOR = "script:fix-bad-access-urls";

const REPOINT = {
  id: "cmsml26t5000kfsfzhp6tdii0",
  expectTitle: "Attention Is All You Need",
  from: "https://langtaosha.org.cn/index.php/lts/preprint/download/10/108",
  to: "https://arxiv.org/abs/1706.03762",
};

const REMOVE = {
  id: "cmsw3lkx3000204l317zivzao",
  expectTitle: "Test",
  url: "https://test.com/",
};

type Deps = { copies: number; loans: number; reservations: number; marc: number; ep: number };

async function dependenciesOf(c: Client, id: string): Promise<Deps> {
  const r = await c.query<Record<keyof Deps, string>>(
    `SELECT (SELECT count(*) FROM "Copy" WHERE "resourceId"=$1)::text AS copies,
            (SELECT count(*) FROM "Loan" WHERE "resourceId"=$1)::text AS loans,
            (SELECT count(*) FROM "Reservation" WHERE "resourceId"=$1)::text AS reservations,
            (SELECT count(*) FROM "MarcField" WHERE "resourceId"=$1)::text AS marc,
            (SELECT count(*) FROM "EpSubmission" WHERE "resourceId"=$1)::text AS ep`,
    [id],
  );
  const row = r.rows[0];
  return {
    copies: Number(row.copies),
    loans: Number(row.loans),
    reservations: Number(row.reservations),
    marc: Number(row.marc),
    ep: Number(row.ep),
  };
}

async function audit(
  c: Client,
  entry: { action: string; entityId: string; summary: string; detail: unknown },
): Promise<void> {
  await c.query(
    `INSERT INTO "AuditLog" (id, actor, action, entity, "entityId", summary, detail)
     VALUES ($1, $2, $3, 'Resource', $4, $5, $6)`,
    [randomUUID(), ACTOR, entry.action, entry.entityId, entry.summary, JSON.stringify(entry.detail)],
  );
}

void (async () => {
  const c = new Client({ connectionString: process.env.POSTGRES_URL_NON_POOLING! });
  await c.connect();
  const db = (await c.query<{ d: string }>(`SELECT current_database() AS d`)).rows[0].d;
  console.log(`database: ${db}`);
  console.log(APPLY ? "MODE: apply\n" : "MODE: dry run, nothing will be written\n");

  let wrote = 0;
  let refused = 0;

  // ---- 1. Repoint the dead URL --------------------------------------------
  {
    const r = await c.query<{ title: string; digitalUrl: string | null; provider: string | null }>(
      `SELECT title, "digitalUrl", provider FROM "Resource" WHERE id = $1`,
      [REPOINT.id],
    );
    const row = r.rows[0];
    if (!row) {
      console.log(`1. repoint: ${REPOINT.id} is not in this database, skipping`);
    } else if (row.title !== REPOINT.expectTitle) {
      console.log(`1. REFUSED: ${REPOINT.id} is titled "${row.title}", expected "${REPOINT.expectTitle}"`);
      refused++;
    } else if (row.digitalUrl === REPOINT.to) {
      console.log("1. repoint: already done");
    } else if (row.digitalUrl !== REPOINT.from) {
      // Someone has edited it since the sweep. Their URL, not this script's,
      // is the current intent.
      console.log(`1. REFUSED: url is now "${row.digitalUrl}", not the one this fixes`);
      refused++;
    } else {
      console.log(`1. repoint "${row.title}"`);
      console.log(`     from ${REPOINT.from}`);
      console.log(`       to ${REPOINT.to}`);
      if (APPLY) {
        await c.query(`UPDATE "Resource" SET "digitalUrl" = $1, "updatedAt" = now() WHERE id = $2`, [
          REPOINT.to,
          REPOINT.id,
        ]);
        // The stale verdict would otherwise keep the record flagged broken
        // until the next nightly scan.
        await c.query(`DELETE FROM "LinkCheck" WHERE "resourceId" = $1`, [REPOINT.id]);
        await audit(c, {
          action: "catalogue.update",
          entityId: REPOINT.id,
          summary: `Repointed a dead access URL for "${row.title}" to the arXiv version of record`,
          detail: {
            field: "digitalUrl",
            before: REPOINT.from,
            after: REPOINT.to,
            why: "the stored URL returned 404 and belonged to an unrelated preprint server",
          },
        });
        wrote++;
        console.log("     done, and the stale link check cleared");
      }
    }
  }

  // ---- 2. Remove the scratch record ---------------------------------------
  {
    const r = await c.query<{ title: string; digitalUrl: string | null; provider: string | null }>(
      `SELECT title, "digitalUrl", provider FROM "Resource" WHERE id = $1`,
      [REMOVE.id],
    );
    const row = r.rows[0];
    if (!row) {
      console.log(`\n2. remove: ${REMOVE.id} is not in this database, skipping`);
    } else if (row.title !== REMOVE.expectTitle || row.digitalUrl !== REMOVE.url) {
      console.log(`\n2. REFUSED: ${REMOVE.id} is now "${row.title}" at "${row.digitalUrl}"`);
      refused++;
    } else {
      const deps = await dependenciesOf(c, REMOVE.id);
      const attached = Object.entries(deps).filter(([, n]) => n > 0);
      console.log(`\n2. remove "${row.title}" (${row.digitalUrl})`);
      if (attached.length > 0) {
        console.log(`     REFUSED: it has ${attached.map(([k, n]) => `${n} ${k}`).join(", ")}`);
        refused++;
      } else if (APPLY) {
        // Audit BEFORE the delete: the row has to be readable to be recorded,
        // and the trail is append-only so the order is the only chance.
        await audit(c, {
          action: "catalogue.delete",
          entityId: REMOVE.id,
          summary: `Deleted the scratch record "${row.title}" from the live catalogue`,
          detail: { title: row.title, provider: row.provider, digitalUrl: row.digitalUrl, dependencies: deps },
        });
        await c.query(`DELETE FROM "LinkCheck" WHERE "resourceId" = $1`, [REMOVE.id]);
        await c.query(`DELETE FROM "Resource" WHERE id = $1`, [REMOVE.id]);
        wrote++;
        console.log("     deleted");
      } else {
        console.log("     no copies, loans, reservations, MARC fields or submissions: safe to delete");
      }
    }
  }

  console.log(
    APPLY
      ? `\n${wrote} change(s) written, ${refused} refused.`
      : `\nDry run. ${refused} would be refused. Re-run with --apply to write.`,
  );
  await c.end();
  process.exit(refused > 0 && APPLY ? 1 : 0);
})();
