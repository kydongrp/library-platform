/**
 * Binary MARC21 (.mrc) reading, round-tripped against the writer.
 *
 *   npx tsx scripts/test-marc-binary.ts
 *
 * Pure: no network, no database.
 *
 * The strongest available check is that the reader and the existing
 * toMarc2709 writer agree: build records, write them to ISO 2709 bytes, read
 * them back, and compare. A reader tested only against hand-written fixtures
 * tends to agree with the fixture author's misunderstanding.
 *
 * The second half feeds it damaged files, because a supplier batch is not a
 * well-formed document. The rule under test is that one bad record loses one
 * record, not the rest of the file.
 */
import { toMarc2709, type MarcRecord } from "../src/lib/marc";
import {
  parseMarcBinary,
  sliceRecords,
  looksLikeMarcBinary,
} from "../src/lib/marc-binary";
import { parseBulkBinary } from "../src/lib/bulk-import";

let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}

/**
 * The leader shape leaderFor() produces in src/lib/marc.ts, so the fixture is
 * exactly what this system writes. 24 characters; /09 = "a" marks UTF-8.
 */
const LEADER = "00000nam a2200000 a 4500";

function rec(over: Partial<MarcRecord> = {}): MarcRecord {
  return {
    leader: LEADER,
    controls: [
      ["001", "res_abc123"],
      ["003", "DLS-ADMIN"],
      ["008", "260828s2024    xxu           000 0 eng d"],
    ],
    fields: [
      { tag: "020", ind1: " ", ind2: " ", subs: [["a", "9780553380163"]] },
      {
        tag: "245",
        ind1: "1",
        ind2: "0",
        subs: [
          ["a", "A Brief History of Time :"],
          ["b", "from the Big Bang to black holes /"],
          ["c", "Stephen Hawking"],
        ],
      },
      { tag: "100", ind1: "1", ind2: " ", subs: [["a", "Hawking, Stephen"]] },
      { tag: "264", ind1: " ", ind2: "1", subs: [["b", "Bantam,"], ["c", "1998."]] },
      { tag: "650", ind1: " ", ind2: "4", subs: [["a", "Science"]] },
      { tag: "856", ind1: "4", ind2: "1", subs: [["u", "https://example.com/x"], ["z", "Access via Bantam"]] },
    ],
    ...over,
  };
}

console.log("Leader sanity (the writer requires exactly 24 chars):");
{
  check("the fixture leader is 24 chars", rec().leader.length === 24, `${rec().leader.length}`);
  check("leader/09 marks UTF-8", rec().leader[9] === "a", JSON.stringify(rec().leader[9]));
}

console.log("\nA record survives a write and read unchanged:");
{
  const original = rec();
  const bytes = toMarc2709([original]);
  const parsed = parseMarcBinary(bytes);

  check("no errors", parsed.errors.length === 0, parsed.errors.join(" | "));
  check("one record", parsed.records.length === 1, String(parsed.records.length));
  check("encoding detected as utf-8", parsed.encoding === "utf-8", parsed.encoding);

  const r = parsed.records[0];
  if (r) {
    const control = (tag: string) => r.fields.find((f) => f.tag === tag)?.value;
    check("001 round-trips", control("001") === "res_abc123", control("001"));
    check("003 round-trips", control("003") === "DLS-ADMIN", control("003"));
    check("008 round-trips", control("008")?.startsWith("260828s2024") === true, control("008"));

    const df = (tag: string) => r.fields.find((f) => f.tag === tag);
    const t245 = df("245");
    check("245 indicators round-trip", t245?.ind1 === "1" && t245?.ind2 === "0", `${t245?.ind1}${t245?.ind2}`);
    check("245 has three subfields", t245?.subs?.length === 3, String(t245?.subs?.length));
    check(
      "245 $a round-trips including punctuation",
      t245?.subs?.[0][1] === "A Brief History of Time :",
      t245?.subs?.[0][1],
    );
    check("245 $c round-trips", t245?.subs?.[2][1] === "Stephen Hawking", t245?.subs?.[2][1]);
    check("subfield order is preserved", t245?.subs?.map((s) => s[0]).join("") === "abc", t245?.subs?.map((s) => s[0]).join(""));

    check("020 ISBN round-trips", df("020")?.subs?.[0][1] === "9780553380163");
    check("100 author round-trips", df("100")?.subs?.[0][1] === "Hawking, Stephen");
    check("264 publisher round-trips", df("264")?.subs?.[0][1] === "Bantam,");
    check("650 subject round-trips", df("650")?.subs?.[0][1] === "Science");
    check("856 url round-trips", df("856")?.subs?.[0][1] === "https://example.com/x");
    check("856 $z round-trips", df("856")?.subs?.[1][1] === "Access via Bantam");
    check("every field is present", r.fields.length === 9, String(r.fields.length));
    check("field order follows the directory", r.fields.map((f) => f.tag).slice(0, 4).join(",") === "001,003,008,020", r.fields.map((f) => f.tag).join(","));
  }
}

console.log("\nA multi-record file reads every record:");
{
  const many = [
    rec({ controls: [["001", "one"]] }),
    rec({ controls: [["001", "two"]] }),
    rec({ controls: [["001", "three"]] }),
  ];
  const parsed = parseMarcBinary(toMarc2709(many));
  check("three records", parsed.records.length === 3, String(parsed.records.length));
  check("no errors", parsed.errors.length === 0, parsed.errors.join(" | "));
  check(
    "each keeps its own 001",
    parsed.records.map((r) => r.fields.find((f) => f.tag === "001")?.value).join(",") === "one,two,three",
    parsed.records.map((r) => r.fields.find((f) => f.tag === "001")?.value).join(","),
  );
  const { slices } = sliceRecords(toMarc2709(many));
  check("slicing finds three records", slices.length === 3, String(slices.length));
}

console.log("\nUnicode survives, because the bytes are never transcoded:");
{
  const uni = rec({
    fields: [
      { tag: "245", ind1: "1", ind2: "0", subs: [["a", "日本の図書館システム"]] },
      { tag: "100", ind1: "1", ind2: " ", subs: [["a", "Müller, Jürgen"]] },
      { tag: "650", ind1: " ", ind2: "4", subs: [["a", "Café société"]] },
    ],
  });
  const parsed = parseMarcBinary(toMarc2709([uni]));
  const r = parsed.records[0];
  const sub = (tag: string) => r?.fields.find((f) => f.tag === tag)?.subs?.[0][1];
  check("CJK round-trips", sub("245") === "日本の図書館システム", sub("245"));
  check("umlauts round-trip", sub("100") === "Müller, Jürgen", sub("100"));
  check("accents round-trip", sub("650") === "Café société", sub("650"));
  // Multi-byte characters make byte offsets differ from character counts,
  // which is the classic place a reader that mixes the two breaks.
  check("no errors despite multi-byte offsets", parsed.errors.length === 0, parsed.errors.join(" | "));
}

console.log("\nEdge shapes:");
{
  const empties = rec({
    fields: [
      { tag: "245", ind1: "1", ind2: "0", subs: [["a", "Title"], ["b", ""]] },
      { tag: "500", ind1: " ", ind2: " ", subs: [["a", "A note with $ and = and : inside"]] },
    ],
  });
  const p = parseMarcBinary(toMarc2709([empties]));
  const r = p.records[0];
  check("an empty subfield value is preserved", r?.fields.find((f) => f.tag === "245")?.subs?.[1][1] === "");
  check(
    "punctuation inside a subfield is not mistaken for framing",
    r?.fields.find((f) => f.tag === "500")?.subs?.[0][1] === "A note with $ and = and : inside",
    r?.fields.find((f) => f.tag === "500")?.subs?.[0][1],
  );

  const controlsOnly = rec({ fields: [], controls: [["001", "only"]] });
  const p2 = parseMarcBinary(toMarc2709([controlsOnly]));
  check("a record of only control fields reads", p2.records.length === 1, p2.errors.join(" | "));

  const long = rec({
    fields: [{ tag: "520", ind1: " ", ind2: " ", subs: [["a", "x".repeat(3000)]] }],
  });
  const p3 = parseMarcBinary(toMarc2709([long]));
  check(
    "a 3000-character abstract round-trips",
    p3.records[0]?.fields.find((f) => f.tag === "520")?.subs?.[0][1]?.length === 3000,
    String(p3.records[0]?.fields.find((f) => f.tag === "520")?.subs?.[0][1]?.length),
  );
}

console.log("\nDamaged files lose one record, not the file:");
{
  const good = toMarc2709([rec({ controls: [["001", "a"]] }), rec({ controls: [["001", "b"]] })]);

  // Wrong declared length in the first leader: the terminator must win.
  const wrongLen = Uint8Array.from(good);
  wrongLen[0] = 0x39; wrongLen[1] = 0x39; wrongLen[2] = 0x39; wrongLen[3] = 0x39; wrongLen[4] = 0x39;
  const p1 = parseMarcBinary(wrongLen);
  check("a wrong length still yields records", p1.records.length >= 1, `${p1.records.length}; ${p1.errors.join(" | ")}`);
  check("and says so", p1.errors.length > 0);

  // Non-numeric length.
  const badLen = Uint8Array.from(good);
  badLen[0] = 0x41;
  const p2 = parseMarcBinary(badLen);
  check("a non-numeric length still yields records", p2.records.length >= 1, p2.errors.join(" | "));

  // Truncated final record.
  const truncated = good.subarray(0, good.length - 40);
  const p3 = parseMarcBinary(truncated);
  check("a truncated tail keeps the earlier record", p3.records.length >= 1, `${p3.records.length}; ${p3.errors.join(" | ")}`);

  // Unusable base address.
  const badBase = Uint8Array.from(good);
  for (let i = 12; i < 17; i++) badBase[i] = 0x5a; // "ZZZZZ"
  const p4 = parseMarcBinary(badBase);
  check("an unusable base address is reported", p4.errors.length > 0, p4.errors.join(" | "));
  check("and the following record still reads", p4.records.length >= 1, String(p4.records.length));
}

console.log("\nNot-MARC input fails cleanly:");
{
  for (const [label, bytes] of [
    ["empty", new Uint8Array(0)],
    ["a few bytes", new Uint8Array([1, 2, 3])],
    ["plain text", new TextEncoder().encode("title,authors,url\nA Book,Someone,https://x.com")],
    ["json", new TextEncoder().encode('[{"title":"A Book"}]')],
    ["xml", new TextEncoder().encode("<?xml version=\"1.0\"?><collection/>")],
    ["all zeroes", new Uint8Array(64)],
  ] as const) {
    let threw = false;
    let out;
    try {
      out = parseMarcBinary(bytes);
    } catch {
      threw = true;
    }
    check(`${label} does not throw`, !threw);
    check(`${label} yields no records`, (out?.records.length ?? 0) === 0, String(out?.records.length));
    check(`${label} explains itself`, (out?.errors.length ?? 0) > 0);
  }
}

console.log("\nFormat sniffing:");
{
  check("real marc is recognised", looksLikeMarcBinary(toMarc2709([rec()])));
  check("csv is not", !looksLikeMarcBinary(new TextEncoder().encode("title,authors\na,b")));
  check("json is not", !looksLikeMarcBinary(new TextEncoder().encode('{"a":1}')));
  check("xml is not", !looksLikeMarcBinary(new TextEncoder().encode("<collection/>")));
  check("empty is not", !looksLikeMarcBinary(new Uint8Array(0)));
  check("short input is not", !looksLikeMarcBinary(new Uint8Array(10)));
  // A CSV that happens to start with digits must not be mistaken for MARC.
  check(
    "a numeric-leading csv is not",
    !looksLikeMarcBinary(new TextEncoder().encode("12345,name,url\n1,a,b")),
  );
}

console.log("\nEnd to end: .mrc bytes become import rows:");
{
  const bytes = toMarc2709([rec(), rec({ controls: [["001", "second"]] })]);
  const parsed = parseBulkBinary(bytes);

  check("format is reported as marc", parsed.format === "marc", parsed.format);
  check("two rows", parsed.rows.length === 2, String(parsed.rows.length));
  check("no errors", parsed.errors.length === 0, parsed.errors.join(" | "));

  const row = parsed.rows[0];
  if (row) {
    // The adapter reuses marcRecordToRow, so ISBD punctuation stripping and the
    // inverted-name handling must come through with it.
    check("title from 245 $a, punctuation stripped", row.title === "A Brief History of Time", row.title ?? "null");
    check("subtitle from 245 $b lands in venue", row.venue?.startsWith("from the Big Bang") === true, row.venue ?? "null");
    check("author from 100 $a", row.authors === "Hawking, Stephen", row.authors ?? "null");
    check("isbn from 020 $a", row.isbn === "9780553380163", row.isbn ?? "null");
    check("url from 856 $u", row.url === "https://example.com/x", row.url ?? "null");
    check("year from 264 $c", row.year === 1998, String(row.year));
    check("type derived from the leader", typeof row.type === "string" && row.type.length > 0, String(row.type));
    check("no category field is produced any more", !("category" in row), Object.keys(row).join(","));
  }

  // Several authors, to confirm the "; " join survives the adapter.
  const multi = parseBulkBinary(toMarc2709([rec({
    fields: [
      { tag: "245", ind1: "1", ind2: "0", subs: [["a", "Shared Work"]] },
      { tag: "100", ind1: "1", ind2: " ", subs: [["a", "Alpha, Ann"]] },
      { tag: "700", ind1: "1", ind2: " ", subs: [["a", "Beta, Bob"]] },
      { tag: "856", ind1: "4", ind2: "0", subs: [["u", "https://example.com/y"]] },
    ],
  })]));
  check(
    "inverted names are joined with a semicolon, not a comma",
    multi.rows[0]?.authors === "Alpha, Ann; Beta, Bob",
    multi.rows[0]?.authors ?? "null",
  );
}

console.log("\nA text file offered as .mrc is refused with a useful message:");
{
  const notMarc = parseBulkBinary(new TextEncoder().encode("<?xml version=\"1.0\"?><collection/>"));
  check("no rows", notMarc.rows.length === 0);
  check("format is unknown", notMarc.format === "unknown", notMarc.format);
  check(
    "the message points at the right fix",
    notMarc.errors.some((e) => e.includes(".xml") || e.includes("MARCXML")),
    notMarc.errors.join(" | "),
  );
}

console.log(
  failures === 0
    ? "\nCLEAN: records survive a write and read unchanged including CJK and accents, and a damaged file loses one record rather than the batch."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
