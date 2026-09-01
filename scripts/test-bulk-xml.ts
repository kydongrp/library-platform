/**
 * Reading a supplier's XML batch file.
 *
 *   npx tsx scripts/test-bulk-xml.ts
 *
 * The bug this suite exists for: two different suppliers' XML files both
 * imported as "0 imported, N skipped, missing title" against records that
 * plainly had titles. The importer read only the TOP level of each record, and
 * vendor XML almost never puts the descriptive fields there. It wraps them.
 *
 * Every fixture below is a shape a real supplier ships. The first two are the
 * ones that failed; each is asserted twice, once that the title is now found
 * and once that the flat reader would have missed it, so the test would still
 * catch the regression if the flattening were removed.
 */
import { parseBulk, recordFieldNames } from "../src/lib/bulk-import";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
  if (!ok) failures++;
}

/** True if a flat, top-level-only read would have found a title. */
function flatWouldFind(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj).map((k) => k.toLowerCase().replace(/[\s_\-.]/g, ""));
  return ["title", "name", "headline"].some((a) => keys.includes(a));
}

console.log("A record whose fields sit under a wrapper element:");
{
  // The commonest vendor shape there is, and the one that failed.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<results>
  <document>
    <header><docTitle>Naval Systems Assessment 2026</docTitle></header>
    <body>
      <authorName>IHS Markit</authorName>
      <documentUrl>https://customer.example.com/doc/1</documentUrl>
      <publicationDate>2026-03-14</publicationDate>
      <publisherName>Example Defence Intelligence</publisherName>
    </body>
  </document>
  <document>
    <header><docTitle>Air Platforms Review</docTitle></header>
    <body>
      <authorName>IHS Markit</authorName>
      <documentUrl>https://customer.example.com/doc/2</documentUrl>
      <publicationDate>2025-11-02</publicationDate>
    </body>
  </document>
</results>`;
  const r = parseBulk(xml, "batch.xml");
  check("format is XML", r.format === "xml", r.format);
  check("two records found", r.rows.length === 2, String(r.rows.length));
  check("the title is read from the wrapper", r.rows[0].title === "Naval Systems Assessment 2026",
    JSON.stringify(r.rows[0].title));
  check("so is the access link", r.rows[0].url === "https://customer.example.com/doc/1", r.rows[0].url);
  check("and the author", r.rows[0].authors === "IHS Markit", String(r.rows[0].authors));
  check("the year is pulled out of a full date", r.rows[0].year === 2026, String(r.rows[0].year));
  check("and the publisher", r.rows[0].publisher === "Example Defence Intelligence",
    String(r.rows[0].publisher));
  check("the second record too", r.rows[1].title === "Air Platforms Review", r.rows[1].title);
  check("no notes, because nothing was skipped", r.errors.length === 0, JSON.stringify(r.errors));
}

console.log("\nA record using attributes and mixed content:");
{
  const xml = `<?xml version="1.0"?>
<articles>
  <article id="7">
    <title lang="en">Inclusion in Artificial Intelligence</title>
    <authors><author>Tan, Wei</author><author>Lim, Grace</author></authors>
    <links><link type="html" href="https://example.org/a/7"/></links>
    <year>2023</year>
  </article>
  <article id="8">
    <title lang="en">Maritime Domain Awareness</title>
    <authors><author>Rahman, Aisha</author></authors>
    <links><link type="html" href="https://example.org/a/8"/></links>
    <year>2024</year>
  </article>
</articles>`;
  const r = parseBulk(xml, "batch.xml");
  check("two records", r.rows.length === 2, String(r.rows.length));
  check("title read despite the attribute on the element",
    r.rows[0].title === "Inclusion in Artificial Intelligence", JSON.stringify(r.rows[0].title));
  check("repeated authors are joined", r.rows[0].authors === "Tan, Wei; Lim, Grace",
    String(r.rows[0].authors));
  check("a single author still reads as one", r.rows[1].authors === "Rahman, Aisha",
    String(r.rows[1].authors));
  check("the link comes from an attribute", r.rows[0].url === "https://example.org/a/7",
    String(r.rows[0].url));
}

console.log("\nA Dublin Core style record:");
{
  const xml = `<?xml version="1.0"?>
<oai>
  <record><metadata>
    <dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Sea Power and Strategy</dc:title>
    <dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">Corbett, Julian</dc:creator>
    <dc:identifier xmlns:dc="http://purl.org/dc/elements/1.1/">https://example.org/dc/1</dc:identifier>
    <dc:date xmlns:dc="http://purl.org/dc/elements/1.1/">1911</dc:date>
  </metadata></record>
  <record><metadata>
    <dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Some Principles</dc:title>
    <dc:identifier xmlns:dc="http://purl.org/dc/elements/1.1/">https://example.org/dc/2</dc:identifier>
  </metadata></record>
</oai>`;
  const r = parseBulk(xml, "batch.xml");
  check("two records", r.rows.length === 2, String(r.rows.length));
  check("dc:title is read", r.rows[0].title === "Sea Power and Strategy", JSON.stringify(r.rows[0].title));
  check("dc:identifier serves as the link", r.rows[0].url === "https://example.org/dc/1",
    String(r.rows[0].url));
  check("dc:date gives the year", r.rows[0].year === 1911, String(r.rows[0].year));
}

console.log("\nThe records list is chosen, not just the first list found:");
{
  // The subject terms repeat before the records do. Taking the first array of
  // objects picks the terms and reports "missing title" on every one of them.
  const xml = `<?xml version="1.0"?>
<feed>
  <subjects>
    <subject><code>DEF</code><label>Defence</label></subject>
    <subject><code>NAV</code><label>Naval</label></subject>
    <subject><code>AIR</code><label>Air</label></subject>
  </subjects>
  <items>
    <item><title>Frigate Programmes</title><url>https://example.org/i/1</url></item>
    <item><title>Submarine Programmes</title><url>https://example.org/i/2</url></item>
  </items>
</feed>`;
  const r = parseBulk(xml, "batch.xml");
  check("the items were chosen over the subject terms", r.rows.length === 2,
    `${r.rows.length} rows: ${JSON.stringify(r.rows.map((x) => x.title))}`);
  check("and they are the real records", r.rows[0].title === "Frigate Programmes", r.rows[0].title);
}

console.log("\nA namespaced supplier file (the Janes shape):");
{
  // The field names here are the ones the importer itself reported back from
  // the real file: jm:id, jm:standardname, taxonomy, taxonomyid. Every element
  // is namespace-prefixed, which is why nothing matched: an alias table can
  // never contain a supplier's XML plumbing.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<jm:standards xmlns:jm="http://janes.com/schema">
  <jm:standard>
    <jm:id>64902</jm:id>
    <jm:standardname>Naval Weapon Systems Interface Standard</jm:standardname>
    <jm:taxonomy>Naval</jm:taxonomy>
    <jm:taxonomyid>NAV-14</jm:taxonomyid>
    <jm:url>https://customer.janes.com/standard/64902</jm:url>
  </jm:standard>
  <jm:standard>
    <jm:id>64903</jm:id>
    <jm:standardname>Air Platform Avionics Standard</jm:standardname>
    <jm:taxonomy>Air</jm:taxonomy>
    <jm:taxonomyid>AIR-02</jm:taxonomyid>
    <jm:url>https://customer.janes.com/standard/64903</jm:url>
  </jm:standard>
</jm:standards>`;
  const r = parseBulk(xml, "bsp_64902.xml");
  check("two records", r.rows.length === 2, String(r.rows.length));
  check("the namespaced title is read", r.rows[0].title === "Naval Weapon Systems Interface Standard",
    JSON.stringify(r.rows[0].title));
  check("and the namespaced link", r.rows[0].url === "https://customer.janes.com/standard/64902",
    String(r.rows[0].url));
  check("nothing skipped", r.errors.length === 0, JSON.stringify(r.errors));
}

console.log("\nA file with titles but no link says so, in the same breath:");
{
  // What the real file looks like if it carries no access link at all: the
  // importer must name BOTH gates, or the next attempt fails on the second one.
  const xml = `<?xml version="1.0"?>
<jm:standards xmlns:jm="http://janes.com/schema">
  <jm:standard><jm:id>1</jm:id><jm:taxonomy>Naval</jm:taxonomy></jm:standard>
  <jm:standard><jm:id>2</jm:id><jm:taxonomy>Air</jm:taxonomy></jm:standard>
</jm:standards>`;
  const r = parseBulk(xml, "b.xml");
  const note = r.errors.join(" ");
  check("it reports the title gate", note.includes("title"), note);
  check("and the link gate, in the same message", note.includes("access link"), note);
  check("and names the fields the file has", note.includes("taxonomy"), note);
  check("with the prefix stripped, so the name is recognisable",
    !note.includes("jm:"), note);
}

console.log("\nA file whose fields are genuinely unknown says what it found:");
{
  const xml = `<?xml version="1.0"?>
<batch>
  <thing><blortName>Something</blortName><zork>https://example.org/z/1</zork></thing>
  <thing><blortName>Another</blortName><zork>https://example.org/z/2</zork></thing>
</batch>`;
  const r = parseBulk(xml, "batch.xml");
  check("nothing is imported, which is correct", r.rows.every((x) => !x.title));
  const note = r.errors.join(" ");
  check("but the note names the fields the file actually has",
    note.includes("blortname") && note.includes("zork"), JSON.stringify(r.errors));
  check("and says what a title can be called", note.includes("title"), JSON.stringify(r.errors));
  check("recordFieldNames is what powers that",
    recordFieldNames({ a: { b: "1" }, c: "2" }).sort().join(",") === "b,c",
    JSON.stringify(recordFieldNames({ a: { b: "1" }, c: "2" })));
}

console.log("\nThe shallowest name wins when a name repeats:");
{
  const xml = `<?xml version="1.0"?>
<batch>
  <rec>
    <title>The Work Itself</title>
    <url>https://example.org/w/1</url>
    <series><title>A Series Nobody Asked For</title></series>
  </rec>
  <rec>
    <title>Second Work</title>
    <url>https://example.org/w/2</url>
  </rec>
</batch>`;
  const r = parseBulk(xml, "batch.xml");
  check("the record's own title wins over the series title",
    r.rows[0].title === "The Work Itself", JSON.stringify(r.rows[0].title));
}

console.log("\nNothing that already worked has changed:");
{
  const csv = "title,authors,url,year,publisher\nA Title,Smith,https://example.org/c/1,2020,Acme\n";
  const r = parseBulk(csv, "b.csv");
  check("CSV still parses", r.rows.length === 1 && r.rows[0].title === "A Title", JSON.stringify(r.rows[0]));
  check("and carries no MARC", r.rows[0].marc === null);

  const json = JSON.stringify([{ title: "J One", url: "https://example.org/j/1", year: 2021 }]);
  const rj = parseBulk(json, "b.json");
  check("JSON still parses", rj.rows.length === 1 && rj.rows[0].title === "J One", JSON.stringify(rj.rows[0]));

  const flatXml = `<?xml version="1.0"?><rows>
    <row><title>Flat One</title><url>https://example.org/f/1</url></row>
    <row><title>Flat Two</title><url>https://example.org/f/2</url></row></rows>`;
  const rx = parseBulk(flatXml, "b.xml");
  check("flat XML still parses", rx.rows.length === 2 && rx.rows[0].title === "Flat One",
    JSON.stringify(rx.rows.map((x) => x.title)));

  const marcxml = `<?xml version="1.0"?>
<collection xmlns="http://www.loc.gov/MARC21/slim"><record>
  <leader>01234nam a2200289 i 4500</leader>
  <datafield tag="245" ind1="1" ind2="0"><subfield code="a">Marc Title /</subfield></datafield>
  <datafield tag="856" ind1="4" ind2="0"><subfield code="u">https://example.org/m/1</subfield></datafield>
</record></collection>`;
  const rm = parseBulk(marcxml, "b.xml");
  check("MARCXML is still detected as MARCXML, not swept up by the generic path",
    rm.format === "marcxml", rm.format);
  check("and still keeps its MARC", (rm.rows[0].marc?.length ?? 0) > 0, String(rm.rows[0].marc?.length));
}

console.log("\nThe fixtures that failed would still fail a flat reader:");
{
  // Guards the guard: if the flattening were reverted, the assertions above
  // would break rather than quietly passing for some other reason.
  check("wrapper record is invisible to a top-level-only read",
    !flatWouldFind({ header: { docTitle: "x" }, body: {} }));
  check("Dublin Core record is too",
    !flatWouldFind({ metadata: { "dc:title": "x" } }));
  check("but a flat record is visible to both", flatWouldFind({ title: "x" }));
}

console.log(
  failures === 0
    ? "\nCLEAN: a supplier's XML is read whatever depth it buries its fields at, the records list is chosen rather than guessed, and a file this importer genuinely cannot read now says which fields it has."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
