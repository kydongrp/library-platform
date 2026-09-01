/**
 * Keeping an imported record's own MARC. Pure: no database, no network.
 *
 *   npx tsx scripts/test-marc-source.ts
 *
 * The bug this suite exists for: a .mrc file imported cleanly, every flat
 * column filled, and the record detail screen then said "No catalogued fields
 * yet" about a record that had arrived fully catalogued. The subjects, notes,
 * series and classification were read to fill six columns and then dropped.
 *
 * What is proved here rather than against a database:
 *   the three tags we regenerate are dropped, and only those three
 *   the source control number survives as an 035, once, and only once
 *   an 008 keeps all 40 of its characters, through the parser AND through export
 *   the rule is idempotent, because the browser and the server both apply it
 *   a hostile or malformed record cannot produce a field ISO 2709 cannot hold
 */
import {
  storableMarcFields, migrateSourceControlNumber, marcPayloadBytes, isLocalUseTag,
  MAX_FIELD_BYTES, MAX_FIELDS_PER_RECORD, MAX_RECORD_BYTES,
  type SourceField,
} from "../src/lib/marc-source";
import { parseBulk, chunkRows, CHUNK_MAX_ROWS, CHUNK_MAX_BYTES } from "../src/lib/bulk-import";
import { toMarcRecord, toMarc2709, toMarcXml, type StoredField } from "../src/lib/marc";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
  if (!ok) failures++;
}

const df = (tag: string, ...subs: [string, string][]): SourceField => ({
  tag, ind1: " ", ind2: " ", value: null,
  subfields: subs.map(([code, value]) => ({ code, value })),
});
const cf = (tag: string, value: string): SourceField => ({
  tag, ind1: " ", ind2: " ", value, subfields: [],
});

/** A realistic vendor record: OCLC control number, full 008, subjects, notes. */
const F008 = "760101s1976    nyu           000 0 eng  ";
const VENDOR: SourceField[] = [
  cf("001", "ocm12345678"),
  cf("003", "OCoLC"),
  cf("005", "20240115103000.0"),
  cf("008", F008),
  df("020", ["a", "9780471234567"]),
  df("100", ["a", "Perry, Robert H."]),
  df("245", ["a", "Chemical engineers' handbook /"], ["c", "Robert H. Perry"]),
  df("264", ["b", "McGraw-Hill,"], ["c", "1976."]),
  df("500", ["a", "Includes index."]),
  df("650", ["a", "Chemical engineering"], ["v", "Handbooks, manuals, etc."]),
  df("650", ["a", "Naval architecture"]),
  df("700", ["a", "Green, Don W."]),
  df("856", ["u", "https://example.org/handbook"]),
];

console.log("What survives an import, and what does not:");
{
  const { fields } = storableMarcFields(VENDOR);
  const tags = fields.map((f) => f.tag);
  check("001 is dropped (we regenerate it as the resource id)", !tags.includes("001"), tags.join(","));
  check("003 is dropped (we regenerate it as DLS-ADMIN)", !tags.includes("003"));
  check("005 is dropped (we regenerate it from updatedAt)", !tags.includes("005"));
  check("008 is KEPT: it is description, not record identity", tags.includes("008"));
  check("subjects survive", tags.filter((t) => t === "650").length === 2, tags.join(","));
  check("notes survive", tags.includes("500"));
  check("added entries survive", tags.includes("700"));
  check("nothing else was lost", fields.length === VENDOR.length - 3 + 1, `${fields.length} kept`);
  // The +1 above is the 035 the control number becomes.
  const f035 = fields.find((f) => f.tag === "035");
  check("the vendor's control number became an 035", !!f035);
  check("qualified by its agency, as MARC 21 prescribes",
    f035?.subfields[0]?.value === "(OCoLC)ocm12345678", JSON.stringify(f035?.subfields));
}

console.log("\nThe 008 keeps every one of its 40 characters:");
{
  const { fields } = storableMarcFields(VENDOR);
  const stored = fields.find((f) => f.tag === "008");
  check("through the import rule", stored?.value === F008,
    `${stored?.value?.length} chars: ${JSON.stringify(stored?.value)}`);
  // And through export, which used to trim it. A trimmed 008 is 38 characters
  // and every offset past the cut is a lie.
  const asStored: StoredField[] = fields.map((f, i) => ({
    tag: f.tag, ind1: f.ind1, ind2: f.ind2, value: f.value, subfields: f.subfields, seq: i + 1,
  }));
  const rec = toMarcRecord(
    {
      id: "res1", title: "Chemical engineers' handbook", subtitle: null, author: "Perry, Robert H.",
      isbn: null, type: "EBOOK", materialDesignation: "MONOGRAPH", category: "Technology",
      publisher: "McGraw-Hill", publishedYear: 1976, language: "english", description: null,
      digital: true, digitalUrl: "https://example.org/handbook", provider: "Test",
      createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
    asStored,
  );
  const exported008 = rec.controls.find(([t]) => t === "008")?.[1];
  check("through export", exported008 === F008,
    `${exported008?.length} chars: ${JSON.stringify(exported008)}`);
  check("and the exported 001 is OURS, not the vendor's",
    rec.controls.find(([t]) => t === "001")?.[1] === "res1",
    JSON.stringify(rec.controls.find(([t]) => t === "001")));
  // A record asserting 003 = DLS-ADMIN over a foreign 001 would be claiming
  // someone else's control number as its own.
  check("while 003 still says DLS-ADMIN", rec.controls.find(([t]) => t === "003")?.[1] === "DLS-ADMIN");
  const xml = toMarcXml([rec]);
  check("MARCXML export carries the 40-char 008", xml.includes(`<controlfield tag="008">${F008}</controlfield>`));
  const bin = toMarc2709([rec]);
  check("binary export serialises without throwing", bin.length > 0);
}

console.log("\nThe rule is idempotent (the browser applies it, then the server does):");
{
  const once = storableMarcFields(VENDOR).fields;
  const twice = storableMarcFields(once).fields;
  check("a second pass changes nothing", JSON.stringify(once) === JSON.stringify(twice),
    `${once.length} -> ${twice.length}`);
  const thrice = storableMarcFields(twice).fields;
  check("nor a third", JSON.stringify(once) === JSON.stringify(thrice));
  check("and it does not stack up 035s", twice.filter((f) => f.tag === "035").length === 1);
}

console.log("\nThe 035 migration, at its edges:");
{
  check("no 001 means no 035", migrateSourceControlNumber([cf("008", F008)]) === null);
  check("an empty 001 means no 035", migrateSourceControlNumber([cf("001", "   ")]) === null);
  const noAgency = migrateSourceControlNumber([cf("001", "12345")]);
  check("no 003 leaves the number unqualified", noAgency?.subfields[0]?.value === "12345",
    JSON.stringify(noAgency));
  const dup = migrateSourceControlNumber([
    cf("001", "ocm999"), cf("003", "OCoLC"), df("035", ["a", "(OCoLC)ocm999"]),
  ]);
  check("an 035 the vendor already supplied is not duplicated", dup === null);
  const bare = migrateSourceControlNumber([
    cf("001", "ocm999"), cf("003", "OCoLC"), df("035", ["a", "ocm999"]),
  ]);
  check("nor when the vendor's own 035 is unqualified", bare === null);
}

console.log("\nA malformed or hostile record cannot break the pipeline:");
{
  const framing = storableMarcFields([
    df("245", ["a", "Title\u001fwith\u001edelimiters\u001dinside"]),
  ]).fields;
  const v = framing[0]?.subfields[0]?.value ?? "";
  check("ISO 2709 framing bytes are stripped from data",
    !/[\u001d\u001e\u001f]/.test(v), JSON.stringify(v));

  check("a non-numeric tag is dropped", storableMarcFields([df("XYZ", ["a", "x"])]).fields.length === 0);
  check("a two-digit tag is dropped", storableMarcFields([df("24", ["a", "x"])]).fields.length === 0);
  check("a field with no usable subfield is dropped",
    storableMarcFields([df("650", ["", ""])]).fields.length === 0);
  check("an empty control field is dropped", storableMarcFields([cf("007", "")]).fields.length === 0);

  // The ISO 2709 directory expresses a field length in four digits, so a field
  // over 9999 bytes cannot be exported at all. Truncation happens here rather
  // than as a throw at export time, on a different day, to a different person.
  const huge = storableMarcFields([df("505", ["a", "x".repeat(50_000)])]);
  check("an oversized field is truncated, not dropped", huge.fields.length === 1);
  check("and it is reported as truncated", huge.truncated === 1, JSON.stringify(huge));
  const bytes = new TextEncoder().encode(huge.fields[0].subfields[0].value).length;
  check(`truncated under the ${MAX_FIELD_BYTES}-byte ceiling`, bytes < MAX_FIELD_BYTES, `${bytes} bytes`);

  // Bytes, not characters: a CJK note is three bytes per character, so a
  // character cap would sail past the ceiling and throw at export.
  const cjk = storableMarcFields([df("505", ["a", "書".repeat(8_000)])]);
  const cjkBytes = new TextEncoder().encode(cjk.fields[0].subfields[0].value).length;
  check("a CJK field is capped by BYTES, not characters", cjkBytes < MAX_FIELD_BYTES, `${cjkBytes} bytes`);
  check("and truncation did not split a character",
    !cjk.fields[0].subfields[0].value.includes("�"));

  const many = storableMarcFields(
    Array.from({ length: MAX_FIELDS_PER_RECORD + 40 }, (_, i) => df("500", ["a", `note ${i}`])),
  );
  check("a record with too many fields is capped", many.fields.length === MAX_FIELDS_PER_RECORD,
    String(many.fields.length));
  check("and the overflow is reported", many.dropped === 40, JSON.stringify(many));

  const fat = storableMarcFields(
    Array.from({ length: 40 }, () => df("505", ["a", "y".repeat(4_000)])),
  );
  check(`a record is capped at ${MAX_RECORD_BYTES} bytes`,
    marcPayloadBytes(fat.fields) <= MAX_RECORD_BYTES, `${marcPayloadBytes(fat.fields)} bytes`);
  check("and that overflow is reported too", fat.dropped > 0, JSON.stringify({ dropped: fat.dropped }));
}

console.log("\nThe local-use 9XX block is not importable:");
{
  // 9XX is defined locally, and this catalogue has defined it: 954 is Point of
  // Contact, carrying a name, an email address and a department. A vendor's own
  // 954 would have appeared on the record screen, in every export, and on the
  // unauthenticated feed, as a DLS point of contact.
  const vendorLocal = storableMarcFields([
    df("245", ["a", "A title"]),
    df("954", ["a", "Jane Tan"], ["b", "jane.tan@example.gov.sg"], ["c", "Acquisitions"]),
    df("951", ["a", "vendor internal code"]),
    df("900", ["a", "anything"]),
  ]).fields;
  const tags = vendorLocal.map((f) => f.tag);
  check("a vendor 954 does not come in", !tags.includes("954"), tags.join(","));
  check("nor any other 9XX", !tags.some((t) => t.startsWith("9")), tags.join(","));
  check("and the real fields still do", tags.includes("245"));
  check("no name or address survived anywhere",
    !JSON.stringify(vendorLocal).includes("jane.tan"), JSON.stringify(vendorLocal));
  check("isLocalUseTag is exact", isLocalUseTag("900") && isLocalUseTag("999") && !isLocalUseTag("090"));
}

console.log("\nA chunk of rows fits the Server Action body limit:");
{
  // A row used to be nine short columns. Now it can carry 60 KB of MARC, and a
  // hundred of those is nearly seven megabytes against a four-megabyte limit.
  const fat = (i: number): SourceField[] =>
    storableMarcFields(
      Array.from({ length: 8 }, () => df("505", ["a", i + " " + "z".repeat(6800)])),
    ).fields;
  const rows = Array.from({ length: 250 }, (_, i) => ({
    title: "t" + i, authors: null, url: "https://example.org/" + i, year: null,
    venue: null, publisher: null, isbn: null, type: null, abstract: null, marc: fat(i),
  }));
  const oneRow = JSON.stringify(rows[0]).length;
  check("one fat row is big enough to matter", oneRow > 40000, oneRow + " bytes");
  check("100 of them WOULD have blown the 4mb limit", oneRow * 100 > 4000000,
    (oneRow * 100 / 1e6).toFixed(2) + " MB");

  const chunks = chunkRows(rows);
  check("chunking split them further than 100 at a time",
    chunks.length > Math.ceil(rows.length / CHUNK_MAX_ROWS), chunks.length + " chunks");
  const worst = Math.max(...chunks.map((c) => JSON.stringify(c).length));
  check("and no chunk exceeds the budget", worst <= CHUNK_MAX_BYTES, worst + " bytes");
  check("every row is still sent exactly once",
    chunks.reduce((n, c) => n + c.length, 0) === rows.length &&
      new Set(chunks.flat().map((r) => r.url)).size === rows.length);
  check("and in order", chunks.flat()[0].url === rows[0].url &&
    chunks.flat()[rows.length - 1].url === rows[rows.length - 1].url);

  // The ordinary case must not have been made slower or chattier.
  const thin = Array.from({ length: 250 }, (_, i) => ({
    title: "t" + i, authors: null, url: "https://example.org/thin/" + i, year: null,
    venue: null, publisher: null, isbn: null, type: null, abstract: null, marc: null,
  }));
  const thinChunks = chunkRows(thin);
  check("a plain CSV batch still chunks by row count alone",
    thinChunks.length === 3 && thinChunks[0].length === CHUNK_MAX_ROWS,
    thinChunks.length + " chunks of " + thinChunks.map((c) => c.length).join("/"));
  check("an empty batch produces no chunks", chunkRows([]).length === 0);
  // A single row over budget must still be sent, not silently dropped.
  const one = chunkRows([rows[0]], 100, 10);
  check("a row bigger than the budget is still sent, alone", one.length === 1 && one[0].length === 1);
}

console.log("\nEnd to end, through the real MARCXML parser:");
{
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<collection xmlns="http://www.loc.gov/MARC21/slim">
  <record>
    <leader>01234nam a2200289 i 4500</leader>
    <controlfield tag="001">ocm55555</controlfield>
    <controlfield tag="003">OCoLC</controlfield>
    <controlfield tag="008">${F008}</controlfield>
    <datafield tag="245" ind1="1" ind2="0">
      <subfield code="a">Naval systems assessment /</subfield>
      <subfield code="c">IHS Markit.</subfield>
    </datafield>
    <datafield tag="650" ind1=" " ind2="0">
      <subfield code="a">Sea-power</subfield>
      <subfield code="z">China</subfield>
    </datafield>
    <datafield tag="856" ind1="4" ind2="0">
      <subfield code="u">https://example.org/naval</subfield>
    </datafield>
  </record>
</collection>`;
  const parsed = parseBulk(xml, "batch.xml");
  check("the file is recognised as MARCXML", parsed.format === "marcxml", parsed.format);
  check("one row", parsed.rows.length === 1);
  const row = parsed.rows[0];
  check("flat columns still filled", row.title === "Naval systems assessment", row.title);
  check("MARC came with it", (row.marc?.length ?? 0) > 0, String(row.marc?.length));

  const tags = (row.marc ?? []).map((f) => f.tag);
  check("245 kept", tags.includes("245"));
  check("650 kept", tags.includes("650"));
  check("035 synthesised from 001+003", tags.includes("035"));
  check("001 not kept", !tags.includes("001"));

  // The reason for stopNodes in parseMarcXml. With the parser's default trim
  // this came back as 38 characters and the record we stored was invalid MARC.
  const parsed008 = (row.marc ?? []).find((f) => f.tag === "008")?.value;
  check("the 008 survived the XML parser at full length", parsed008 === F008,
    `${parsed008?.length} chars: ${JSON.stringify(parsed008)}`);

  const f650 = (row.marc ?? []).find((f) => f.tag === "650");
  check("indicators are preserved", f650?.ind1 === " " && f650?.ind2 === "0",
    JSON.stringify([f650?.ind1, f650?.ind2]));
  check("subfield order and codes are preserved",
    JSON.stringify(f650?.subfields) === JSON.stringify([
      { code: "a", value: "Sea-power" }, { code: "z", value: "China" },
    ]), JSON.stringify(f650?.subfields));
}

console.log("\nA non-MARC batch carries no MARC:");
{
  const csv = "title,url,publisher\nA Title,https://example.org/a,Acme\n";
  const parsed = parseBulk(csv, "batch.csv");
  check("CSV parses", parsed.rows.length === 1, JSON.stringify(parsed.errors));
  check("and its row has marc = null", parsed.rows[0].marc === null, JSON.stringify(parsed.rows[0].marc));
}

console.log(
  failures === 0
    ? "\nCLEAN: an imported record keeps its own cataloguing, its 008 survives intact end to end, the vendor's control number becomes an 035 exactly once, and no file can produce a field the export format cannot hold."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
