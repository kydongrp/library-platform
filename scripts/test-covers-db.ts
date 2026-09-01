/**
 * Common cover images, against a real database.
 *
 *   npx tsx --env-file=.env.test scripts/test-covers-db.ts
 *
 * REFUSES to run against the live database: it creates and deletes records, and
 * the whole point of the test database is that a suite can never reach
 * production. Everything it makes is namespaced and torn down at the end, so a
 * re-run starts clean rather than accumulating fixtures (a lesson this repo
 * learned the hard way: a suite that adds two rows and deletes one rots).
 *
 * What is worth proving here rather than in the pure suite:
 *   the pool query excludes retired images
 *   an import assigns a cover, and reports how many
 *   deleting an image leaves the records standing on their placeholder
 *   the backfill fills only nulls, so it is safe to run twice
 */
import { prisma } from "../src/lib/db";
import { importResourceRowsCore } from "../src/lib/ingest";
import { loadCoverPool, backfillCovers, describeTally, emptyTally, countAssignment } from "../src/lib/cover-images";
import { tokenFromFileName } from "../src/lib/cover-match";

const TAG = "covertest";
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
  if (!ok) failures++;
}

/** A one-pixel PNG, built from bytes so no fixture file is needed. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000a49444154789c6300010000050001",
  "hex",
);

/**
 * Ids of every image this suite creates.
 *
 * Cleanup cannot key on a file-name prefix: a genuinely GENERAL fixture has to
 * be named `general-<n>.png`, because the token is the whole rule and a tagged
 * name like `covertest-general-1.png` carries the token "covertest general",
 * which is not general at all. That distinction is the feature working, so the
 * suite adapts to it rather than the other way round.
 */
const madeImages: string[] = [];

async function cleanup(): Promise<void> {
  await prisma.resource.deleteMany({ where: { provider: TAG } });
  if (madeImages.length) {
    await prisma.coverImage.deleteMany({ where: { id: { in: madeImages } } });
  }
  await prisma.coverImage.deleteMany({ where: { fileName: { startsWith: TAG } } });
}

void (async () => {
  const dbName = (await prisma.$queryRaw<{ d: string }[]>`SELECT current_database() AS d`)[0].d;
  console.log(`database: ${dbName}\n`);
  if (!/_test$/.test(dbName)) {
    console.error(
      `REFUSING to run: ${dbName} is not a _test database. This suite creates and deletes records.\n` +
        "Run it with --env-file=.env.test.",
    );
    process.exit(1);
  }

  await cleanup();

  console.log("The pool query, which every import depends on:");
  const [general, publisherImg, retired] = await Promise.all([
    // Named `general-<n>` because that is what makes a token general. A tagged
    // name would carry the token "covertest general" and never be picked, which
    // is exactly the trap the admin screen now warns about.
    prisma.coverImage.create({
      data: { fileName: "general-99.png", token: tokenFromFileName("general-99.png"), mimeType: "image/png", sizeBytes: PNG.byteLength, bytes: PNG },
    }),
    prisma.coverImage.create({
      data: { fileName: `${TAG} press 1.png`, token: tokenFromFileName(`${TAG} press 1.png`), mimeType: "image/png", sizeBytes: PNG.byteLength, bytes: PNG },
    }),
    prisma.coverImage.create({
      data: { fileName: `${TAG}-retired-1.png`, token: tokenFromFileName(`${TAG}-retired-1.png`), mimeType: "image/png", sizeBytes: PNG.byteLength, bytes: PNG, enabled: false },
    }),
  ]);
  madeImages.push(general.id, publisherImg.id, retired.id);

  const pool = await loadCoverPool();
  const ids = new Set(pool.map((p) => p.id));
  check("an enabled image is in the pool", ids.has(general.id));
  check("a RETIRED image is not", !ids.has(retired.id), `${pool.length} in pool`);
  check("the pool carries no image bytes", !("bytes" in (pool[0] ?? {})));
  // The token is stored, not re-derived at match time, so it must be right.
  check("stored token strips the sequence number", publisherImg.token === `${TAG} press`, publisherImg.token);

  console.log("\nAn import assigns a cover and says how many:");
  const url = `https://example.org/${TAG}/one`;
  const res = await importResourceRowsCore(
    [{ title: `${TAG} first title`, url, publisher: `${TAG} press` } as never],
    { provider: TAG, defaultType: "JOURNAL" },
  );
  check("one record imported", res.imported === 1, JSON.stringify(res));
  check("one cover assigned", res.coverTally.assigned === 1, JSON.stringify(res.coverTally));
  // Imports land Uncategorised, so this must be the PUBLISHER tier, not collection.
  check("matched on publisher, not collection", res.coverTally.publisher === 1 && res.coverTally.collection === 0, JSON.stringify(res.coverTally));
  check("and it is described for staff", (describeTally(res.coverTally) ?? "").includes("by publisher"), String(describeTally(res.coverTally)));

  const created = await prisma.resource.findFirst({ where: { digitalUrl: url }, select: { id: true, coverImageId: true } });
  check("the record points at the publisher image", created?.coverImageId === publisherImg.id, String(created?.coverImageId));

  console.log("\nA record whose publisher matches nothing falls back to general:");
  const url2 = `https://example.org/${TAG}/two`;
  const res2 = await importResourceRowsCore(
    [{ title: `${TAG} second title`, url: url2, publisher: "Nobody At All" } as never],
    { provider: TAG, defaultType: "JOURNAL" },
  );
  check("imported", res2.imported === 1);
  check("counted as general", res2.coverTally.general === 1, JSON.stringify(res2.coverTally));
  const created2 = await prisma.resource.findFirst({ where: { digitalUrl: url2 }, select: { coverImageId: true } });
  check("and points at the general image", created2?.coverImageId === general.id);

  console.log("\nA duplicate import must not be reported as a fresh cover:");
  const res3 = await importResourceRowsCore(
    [{ title: `${TAG} first title`, url, publisher: `${TAG} press` } as never],
    { provider: TAG, defaultType: "JOURNAL" },
  );
  check("nothing imported", res3.imported === 0, JSON.stringify(res3));
  check("no covers claimed", res3.coverTally.assigned === 0, JSON.stringify(res3.coverTally));
  check("describeTally says nothing rather than zero", describeTally(res3.coverTally) === null);

  console.log("\nDeleting an image leaves its records standing:");
  const before = await prisma.resource.count({ where: { coverImageId: general.id } });
  check("the general image is in use", before >= 1, String(before));
  await prisma.coverImage.delete({ where: { id: general.id } });
  const orphan = await prisma.resource.findFirst({ where: { digitalUrl: url2 }, select: { id: true, coverImageId: true } });
  check("the record survives the delete", orphan !== null);
  check("and falls back to the coloured placeholder", orphan?.coverImageId === null, String(orphan?.coverImageId));

  console.log("\nBackfill fills only nulls, so a second run is a no-op:");
  const stray = await prisma.resource.create({
    data: { title: `${TAG} stray`, author: "Unknown", type: "JOURNAL", provider: TAG, publisher: `${TAG} press`, digitalUrl: `https://example.org/${TAG}/three` },
    select: { id: true },
  });
  const fill1 = await backfillCovers(50, () => 0);
  check("the stray got a cover", fill1.assigned >= 1, JSON.stringify(fill1));
  const filled = await prisma.resource.findUnique({ where: { id: stray.id }, select: { coverImageId: true } });
  check("and it is the publisher image", filled?.coverImageId === publisherImg.id);
  // Snapshot every cover of ours BEFORE the second run, so "no-op" is measured
  // rather than inferred. The previous version asserted
  // `fill2.assigned === 0 || fill2.considered > 0`, which is true whenever
  // considered > 0 no matter what the run did: it would have passed even if the
  // second pass had reassigned every cover. A test that cannot fail is not a test.
  const snapshot = new Map(
    (await prisma.resource.findMany({
      where: { provider: TAG },
      select: { id: true, coverImageId: true },
    })).map((r) => [r.id, r.coverImageId]),
  );

  await backfillCovers(50, () => 0);

  const after = await prisma.resource.findMany({
    where: { provider: TAG },
    select: { id: true, coverImageId: true },
  });
  const changed = after.filter((r) => snapshot.get(r.id) !== r.coverImageId);
  check(
    "a second run changed NO record of ours",
    changed.length === 0,
    changed.map((r) => `${r.id}: ${snapshot.get(r.id)} -> ${r.coverImageId}`).join("; "),
  );
  // And prove the check can fail: clear one cover and confirm the run fills it,
  // so "nothing changed" above means the backfill was idle, not that it is inert.
  await prisma.resource.update({ where: { id: stray.id }, data: { coverImageId: null } });
  const fill3 = await backfillCovers(50, () => 0);
  const refilled = await prisma.resource.findUnique({ where: { id: stray.id }, select: { coverImageId: true } });
  check("but it DOES fill a cover cleared since", refilled?.coverImageId === publisherImg.id, JSON.stringify(fill3));

  console.log("\nThe tally helper:");
  const t = emptyTally();
  countAssignment(t, { coverImageId: null, matchedOn: null });
  check("a null assignment counts nothing", t.assigned === 0);
  countAssignment(t, { coverImageId: "x", matchedOn: "collection" });
  check("a collection match counts once", t.assigned === 1 && t.collection === 1);

  await cleanup();
  const left = await prisma.coverImage.count({ where: { fileName: { startsWith: TAG } } });
  check("teardown removed every fixture", left === 0, `${left} left`);

  console.log(
    failures === 0
      ? "\nCLEAN: retired images stay out of the pool, imports assign and report honestly, a deleted image leaves records on their placeholder, and the backfill is safe to repeat."
      : `\nFAILED: ${failures} assertion(s).`,
  );
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
})();
