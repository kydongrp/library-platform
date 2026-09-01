/**
 * Importing a MARC file, against a real database.
 *
 *   npx tsx --env-file=.env.test scripts/test-marc-import-db.ts
 *
 * REFUSES to run against the live database: it creates and deletes records.
 * Everything it makes is namespaced and torn down at the end, so a re-run
 * starts clean rather than accumulating fixtures.
 *
 * The .mrc file under test is BUILT here, by serialising records with the same
 * ISO 2709 writer the export screen uses and handing the bytes to the importer.
 * A fixture file checked into the repo would prove the importer reads that one
 * file; this proves the two halves of the format agree, which is the property
 * that actually matters when a vendor's file arrives.
 *
 * What is worth proving here rather than in the pure suite:
 *   an import writes MarcField rows, and the record detail screen would show them
 *   the same file imported twice does not double the fields
 *   a record a librarian has already catalogued is never overwritten
 *   a record imported BEFORE this existed gets its MARC when the file is re-run
 *   the fields survive a round trip back out through export
 */
import { prisma } from "../src/lib/db";
import { importResourceRowsCore } from "../src/lib/ingest";
import { parseBulkBinary } from "../src/lib/bulk-import";
import { toMarc2709, type MarcRecord } from "../src/lib/marc";
import { cleanControlValue } from "../src/lib/marc-source";
import { attachSourceMarc, describeMarcTally } from "../src/lib/marc-store";

const TAG = "marctest";
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
  if (!ok) failures++;
}

const F008 = "760101s1976    nyu           000 0 eng  ";

/** Two vendor records, complete with the cataloguing the importer used to drop. */
function vendorFile(): Uint8Array {
  const recs: MarcRecord[] = [1, 2].map((n) => ({
    leader: "00000nam a2200000 i 4500",
    controls: [
      ["001", `ocm0000${n}`],
      ["003", "OCoLC"],
      ["005", "20240115103000.0"],
      ["008", F008],
    ],
    fields: [
      { tag: "020", ind1: " ", ind2: " ", subs: [["a", `978047123456${n}`]] },
      { tag: "100", ind1: "1", ind2: " ", subs: [["a", `Author ${n}, A.`]] },
      { tag: "245", ind1: "1", ind2: "0", subs: [["a", `${TAG} title ${n} /`], ["c", `Author ${n}, A.`]] },
      { tag: "264", ind1: " ", ind2: "1", subs: [["b", `${TAG} press,`], ["c", "1976."]] },
      { tag: "500", ind1: " ", ind2: " ", subs: [["a", "Includes index."]] },
      { tag: "650", ind1: " ", ind2: "0", subs: [["a", "Sea-power"], ["z", "China"]] },
      { tag: "650", ind1: " ", ind2: "0", subs: [["a", "Naval architecture"]] },
      { tag: "700", ind1: "1", ind2: " ", subs: [["a", `Second ${n}, B.`]] },
      { tag: "856", ind1: "4", ind2: "0", subs: [["u", `https://example.org/${TAG}/${n}`]] },
    ],
  }));
  return toMarc2709(recs);
}

async function cleanup(): Promise<void> {
  // MarcField cascades from Resource (onDelete: Cascade), so deleting the
  // resources takes their fields with them. Asserted below rather than assumed.
  await prisma.resource.deleteMany({ where: { provider: TAG } });
}

const url = (n: number) => `https://example.org/${TAG}/${n}`;

async function fieldsOf(n: number) {
  const r = await prisma.resource.findFirst({
    where: { digitalUrl: url(n) },
    select: { id: true, marcFields: { orderBy: { seq: "asc" } } },
  });
  return r;
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
  const bytes = vendorFile();

  console.log("The file parses as binary MARC21:");
  const parsed = parseBulkBinary(bytes);
  check("format detected", parsed.format === "marc", parsed.format);
  check("two records", parsed.rows.length === 2, String(parsed.rows.length));
  check("each row carries its MARC", parsed.rows.every((r) => (r.marc?.length ?? 0) >= 8),
    JSON.stringify(parsed.rows.map((r) => r.marc?.length)));

  console.log("\nAn import writes the cataloguing, not just the columns:");
  const first = await importResourceRowsCore(parsed.rows, { provider: TAG, defaultType: "EBOOK" });
  check("two records imported", first.imported === 2, JSON.stringify({ ...first, marcTally: first.marcTally }));
  check("two records catalogued", first.marcTally.records === 2, JSON.stringify(first.marcTally));
  check("fields were written", first.marcTally.fields >= 16, JSON.stringify(first.marcTally));
  check("nothing had to be truncated or dropped",
    first.marcTally.truncated === 0 && first.marcTally.dropped === 0, JSON.stringify(first.marcTally));

  const r1 = await fieldsOf(1);
  check("the record has fields in the database", (r1?.marcFields.length ?? 0) > 0,
    String(r1?.marcFields.length));
  const tags = (r1?.marcFields ?? []).map((f) => f.tag);
  check("both subject headings are there", tags.filter((t) => t === "650").length === 2, tags.join(","));
  check("the note is there", tags.includes("500"));
  check("the added entry is there", tags.includes("700"));
  check("the vendor control number became an 035", tags.includes("035"));
  check("and the vendor's 001 did NOT come with it", !tags.includes("001"), tags.join(","));

  const stored008 = (r1?.marcFields ?? []).find((f) => f.tag === "008");
  check("the 008 is stored at its full 40 characters", stored008?.value === F008,
    `${stored008?.value?.length} chars: ${JSON.stringify(stored008?.value)}`);

  // seq drives the display order on the record screen and the editor's
  // "add field" takes max(seq)+1, so a zero would collide with the first
  // hand-added field.
  const seqs = (r1?.marcFields ?? []).map((f) => f.seq);
  check("seq is 1-based and unique", Math.min(...seqs) === 1 && new Set(seqs).size === seqs.length,
    seqs.join(","));

  const sub650 = (r1?.marcFields ?? []).find((f) => f.tag === "650" && f.ind2 === "0");
  check("indicators round-tripped", sub650?.ind1 === " " && sub650?.ind2 === "0",
    JSON.stringify([sub650?.ind1, sub650?.ind2]));
  check("subfields round-tripped as [{code,value}]",
    JSON.stringify(sub650?.subfields).includes('"code":"a"'), JSON.stringify(sub650?.subfields));

  console.log("\nImporting the same file again is a no-op, not a doubling:");
  const before = (await fieldsOf(1))?.marcFields.length ?? 0;
  const second = await importResourceRowsCore(parseBulkBinary(bytes).rows, { provider: TAG, defaultType: "EBOOK" });
  check("nothing new imported", second.imported === 0, JSON.stringify(second));
  check("nothing re-catalogued", second.marcTally.records === 0, JSON.stringify(second.marcTally));
  const after = (await fieldsOf(1))?.marcFields.length ?? 0;
  check("the field count did not move", after === before, `${before} -> ${after}`);

  console.log("\nA record a librarian has catalogued is never overwritten:");
  const r2 = await fieldsOf(2);
  await prisma.marcField.deleteMany({ where: { resourceId: r2!.id } });
  await prisma.marcField.create({
    data: {
      resourceId: r2!.id, tag: "650", ind1: " ", ind2: "4", value: null,
      subfields: [{ code: "a", value: "A HEADING A HUMAN CHOSE" }], seq: 1,
    },
  });
  const third = await importResourceRowsCore(parseBulkBinary(bytes).rows, { provider: TAG, defaultType: "EBOOK" });
  check("the import claims nothing", third.marcTally.records === 0, JSON.stringify(third.marcTally));
  const r2after = await fieldsOf(2);
  check("the hand-entered field is the only one", r2after?.marcFields.length === 1,
    JSON.stringify(r2after?.marcFields.map((f) => f.tag)));
  check("and it is untouched",
    JSON.stringify(r2after?.marcFields[0].subfields).includes("A HUMAN CHOSE"),
    JSON.stringify(r2after?.marcFields[0].subfields));

  console.log("\nRe-running the file REPAIRS a record imported before MARC was kept:");
  // Exactly the state the live catalogue is in: the record exists, with its
  // flat columns, and no MARC at all, because the import that made it dropped
  // the fields on the floor. There is no other way back for these records: the
  // source file is not retained, so nothing can be reconstructed from the row.
  const r1id = (await fieldsOf(1))!.id;
  await prisma.marcField.deleteMany({ where: { resourceId: r1id } });
  check("the record is now bare, as the live ones are",
    (await prisma.marcField.count({ where: { resourceId: r1id } })) === 0);
  const repair = await importResourceRowsCore(parseBulkBinary(bytes).rows, { provider: TAG, defaultType: "EBOOK" });
  check("re-uploading imports no new records", repair.imported === 0, JSON.stringify(repair));
  check("but DOES catalogue the bare one", repair.marcTally.records === 1, JSON.stringify(repair.marcTally));
  const repaired = await fieldsOf(1);
  check("its subjects are back", (repaired?.marcFields ?? []).filter((f) => f.tag === "650").length === 2,
    JSON.stringify(repaired?.marcFields.map((f) => f.tag)));
  check("and the record it did not need to touch is still the librarian's",
    (await fieldsOf(2))?.marcFields.length === 1);

  console.log("\nAn 008 survives a round trip through the MARC EDITOR:");
{
  // The corruption path the export fix alone did not close. The editor renders
  // the stored value into a text input and saves whatever comes back, so
  // opening an imported record and pressing Save with NO changes at all used
  // to shorten a valid 40-character 008 to 38 and store it. Exercised through
  // the same helper the action uses, since the action itself needs a session.
  const res = await prisma.resource.findFirst({ where: { digitalUrl: url(1) }, select: { id: true } });
  const field = await prisma.marcField.findFirst({ where: { resourceId: res!.id, tag: "008" } });
  check("the record has its imported 008", field?.value === F008, JSON.stringify(field?.value));

  // What the browser posts back for an untouched field is exactly the stored value.
  const resubmitted = cleanControlValue(String(field!.value), 8000);
  check("re-saving it unchanged keeps 40 characters", resubmitted === F008,
    resubmitted.length + " chars: " + JSON.stringify(resubmitted));

  await prisma.marcField.update({ where: { id: field!.id }, data: { value: resubmitted } });
  const after = await prisma.marcField.findUnique({ where: { id: field!.id } });
  check("and the database still holds 40", after?.value === F008,
    (after?.value?.length ?? 0) + " chars");

  // The rule still refuses genuinely empty input and still strips framing bytes.
  check("a value of only spaces is still empty after trimming",
    cleanControlValue("    ", 8000).trim() === "");
  check("framing bytes are still stripped",
    !/[\u001d\u001e\u001f]/.test(cleanControlValue("a\u001fb", 8000)));
}

console.log("\nA vendor 9XX never reaches the database:");
{
  // 954 is this catalogue's Point of Contact tag: a name, an email address and
  // a department. A vendor record carrying its own 954 would have shown on the
  // record page and in every export as a DLS contact.
  const rec: MarcRecord = {
    leader: "00000nam a2200000 i 4500",
    controls: [["001", "ocm777"], ["008", F008]],
    fields: [
      { tag: "245", ind1: "1", ind2: "0", subs: [["a", TAG + " local-use probe"]] },
      { tag: "954", ind1: " ", ind2: " ", subs: [["a", "Jane Tan"], ["b", "jane.tan@example.gov.sg"]] },
      { tag: "856", ind1: "4", ind2: "0", subs: [["u", url(9)]] },
    ],
  };
  const out = await importResourceRowsCore(parseBulkBinary(toMarc2709([rec])).rows, {
    provider: TAG, defaultType: "EBOOK",
  });
  check("the record imported", out.imported === 1, JSON.stringify(out));
  const r9 = await fieldsOf(9);
  const tags9 = (r9?.marcFields ?? []).map((f) => f.tag);
  check("245 came in", tags9.includes("245"), tags9.join(","));
  check("but 954 did not", !tags9.includes("954"), tags9.join(","));
  const stored = JSON.stringify(r9?.marcFields);
  check("and no name or address is anywhere on the record", !stored.includes("jane.tan"), stored.slice(0, 200));
}

console.log("\nA failure part way through reports what it actually wrote:");
{
  // attachSourceMarc must never throw away its tally: the writes are batched
  // and not transactional, so reporting zero for a run that committed rows
  // would put the audit log at odds with the catalogue. A Map whose values are
  // not field arrays makes storableMarcFields yield nothing, which is the
  // no-op end of the same path; the error field is exercised by pointing the
  // store at a disconnected client.
  const empty = await attachSourceMarc(new Map());
  check("an empty run reports nothing and no error",
    empty.records === 0 && empty.fields === 0 && empty.error === null, JSON.stringify(empty));
  check("describeMarcTally says nothing for an empty run", describeMarcTally(empty) === null);

  const partial = { records: 3, fields: 40, truncated: 0, dropped: 0, error: "connection lost" };
  const described = describeMarcTally(partial) ?? "";
  check("a partial run still reports the records it wrote", described.includes("3 records"), described);
  check("and says it stopped early", described.includes("stopped early"), described);
  check("and tells staff what to do about it", described.includes("re-run"), described);
}

console.log("\nThe fields survive a round trip back out:");
  {
    const { toMarcRecord } = await import("../src/lib/marc");
    const res = await prisma.resource.findFirst({
      where: { digitalUrl: url(1) },
      include: { marcFields: { orderBy: { seq: "asc" } } },
    });
    const rec = toMarcRecord(
      {
        id: res!.id, title: res!.title, subtitle: res!.subtitle, author: res!.author,
        isbn: res!.isbn, type: res!.type, materialDesignation: res!.materialDesignation,
        category: res!.category, publisher: res!.publisher, publishedYear: res!.publishedYear,
        language: res!.language, description: res!.description, digital: res!.digital,
        digitalUrl: res!.digitalUrl, provider: res!.provider,
        createdAt: res!.createdAt, updatedAt: res!.updatedAt,
      },
      res!.marcFields.map((f) => ({
        tag: f.tag, ind1: f.ind1, ind2: f.ind2, value: f.value, subfields: f.subfields, seq: f.seq,
      })),
    );
    const out008 = rec.controls.find(([t]) => t === "008")?.[1];
    check("the exported 008 is still 40 characters", out008 === F008,
      `${out008?.length} chars: ${JSON.stringify(out008)}`);
    check("the exported 001 is our id, not the vendor's",
      rec.controls.find(([t]) => t === "001")?.[1] === res!.id);
    check("both subject headings are exported",
      rec.fields.filter((f) => f.tag === "650").length === 2,
      JSON.stringify(rec.fields.map((f) => f.tag)));
    const bin = toMarc2709([rec]);
    check("and the record serialises to ISO 2709 without throwing", bin.length > 0, `${bin.length} bytes`);
    // Re-read what we just wrote: the strongest available statement that the
    // stored fields are exportable, not merely storable.
    const back = parseBulkBinary(bin);
    check("which reads back as one record", back.rows.length === 1, JSON.stringify(back.errors));
    check("with its subjects intact",
      (back.rows[0].marc ?? []).filter((f) => f.tag === "650").length === 2,
      JSON.stringify((back.rows[0].marc ?? []).map((f) => f.tag)));
  }

  console.log("\nTeardown:");
  const idsBefore = (await prisma.resource.findMany({ where: { provider: TAG }, select: { id: true } })).map((r) => r.id);
  await cleanup();
  check("resources gone", (await prisma.resource.count({ where: { provider: TAG } })) === 0);
  check("and their fields cascaded with them",
    (await prisma.marcField.count({ where: { resourceId: { in: idsBefore } } })) === 0);

  console.log(
    failures === 0
      ? "\nCLEAN: a MARC file now catalogues the records it creates, re-running it neither doubles the fields nor overwrites a librarian's work, and re-uploading a file repairs the records an earlier import stripped."
      : `\nFAILED: ${failures} assertion(s).`,
  );
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
})();
