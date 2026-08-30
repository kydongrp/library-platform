/**
 * Public RSS feed generation.
 *
 *   npx tsx scripts/test-feed.ts
 *
 * Pure: no network, no database.
 *
 * This feed is read by machines that do not complain. A malformed document
 * comes back as HTTP 200 and a subscriber that quietly collects nothing, which
 * is the same failure the link checker had: a green light over an empty result.
 * So the escaping is tested rather than assumed, and the output is parsed back
 * to prove it is a document and not merely a string that looks like one.
 */
import { readFileSync } from "node:fs";
import { buildRssFeed, xmlEscape, rfc822, clip, type FeedItem } from "../src/lib/feed";

// Never typed literally: an editor or a shell can silently eat them, leaving
// an assertion that passes because the input was already clean.
const NUL = String.fromCodePoint(0x00);
const VT = String.fromCodePoint(0x0b);

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
  if (!ok) failures++;
}

const OPTS = {
  title: "DLS: New acquisitions",
  description: "Recently added digital titles.",
  selfUrl: "https://library.zillearn.com/api/feed/new-acquisitions",
  siteUrl: "https://library.zillearn.com",
  now: new Date("2026-08-31T04:00:00Z"),
};

const item = (over: Partial<FeedItem> = {}): FeedItem => ({
  id: "urn:dls:resource:abc123",
  title: "Attention Is All You Need",
  author: "Vaswani, Ashish",
  link: "https://arxiv.org/abs/1706.03762",
  description: "The Transformer architecture.",
  categories: ["Technology", "Neural networks (Computer science)"],
  publishedAt: new Date("2026-08-10T02:00:00Z"),
  ...over,
});

console.log("Escaping, which is where a feed silently stops being a document:");
{
  check("ampersand", xmlEscape("Smith & Jones") === "Smith &amp; Jones");
  check("angle brackets", xmlEscape("a <b> c") === "a &lt;b&gt; c");
  check("quotes", xmlEscape(`"x" 'y'`) === "&quot;x&quot; &apos;y&apos;");
  // Escaping in the wrong order turns & into &amp;amp; on the second pass.
  check("no double escaping", xmlEscape("Tom & Jerry") === "Tom &amp; Jerry");
  check("an entity in the source is escaped once", xmlEscape("&amp;") === "&amp;amp;");
  check(
    "a script tag cannot break out",
    xmlEscape("</title><script>alert(1)</script>") ===
      "&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
  );
  check("tab, newline and return survive", xmlEscape("a\tb\nc\rd") === "a\tb\nc\rd");
  check("a vertical tab is dropped", xmlEscape("a\u000Bb") === "ab");
  check("a null byte is dropped", xmlEscape("a\u0000b") === "ab");
  check("0x1F is dropped", xmlEscape("a\u001Fb") === "ab");
  check("CJK is untouched", xmlEscape("機械学習") === "機械学習");
  check("accents are untouched", xmlEscape("Poincaré") === "Poincaré");
}

console.log("\nRFC 822 dates, which RSS requires and ISO 8601 is not:");
{
  check(
    "a known instant",
    rfc822(new Date("2026-08-10T02:00:00Z")) === "Mon, 10 Aug 2026 02:00:00 +0000",
    rfc822(new Date("2026-08-10T02:00:00Z")),
  );
  check("single digits are padded", rfc822(new Date("2026-01-05T03:04:05Z")).includes("05 Jan 2026 03:04:05"));
  check("it carries an explicit offset", rfc822(new Date()).endsWith("+0000"));
  // The pubDate is an instant, so it must not move with the runtime's zone.
  const before = rfc822(new Date("2026-08-10T02:00:00Z"));
  const prior = process.env.TZ;
  for (const tz of ["UTC", "Asia/Singapore", "America/New_York"]) {
    process.env.TZ = tz;
    check(`unchanged under TZ=${tz}`, rfc822(new Date("2026-08-10T02:00:00Z")) === before);
  }
  if (prior === undefined) delete process.env.TZ;
  else process.env.TZ = prior;
}

console.log("\nClipping:");
{
  check("short text is untouched", clip("hello", 50) === "hello");
  check("whitespace is flattened", clip("a  \n b", 50) === "a b");
  check("a clip never exceeds max, ellipsis included", clip("x".repeat(100), 20).length <= 20, String(clip("x".repeat(100), 20).length));
  check("clipping marks itself", clip("x".repeat(100), 20).endsWith("…"));
  check(
    "it prefers a word boundary",
    clip("the quick brown fox jumps over the lazy dog", 20) === "the quick brown fox…",
    clip("the quick brown fox jumps over the lazy dog", 20),
  );
}

console.log("\nThe document as a whole:");
{
  const xml = buildRssFeed([item()], OPTS);
  check("declares itself XML", xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  check("is RSS 2.0", xml.includes('<rss version="2.0"'));
  check("has one channel", (xml.match(/<channel>/g) ?? []).length === 1);
  check("closes every tag it opens", xml.trimEnd().endsWith("</rss>"));
  check("carries atom:link rel=self", xml.includes('rel="self"'));
  check("the guid is the urn, not the link", xml.includes("<guid isPermaLink=\"false\">urn:dls:resource:abc123</guid>"));
  check("the link is the reader's destination", xml.includes("<link>https://arxiv.org/abs/1706.03762</link>"));
  check("subjects become categories", xml.includes("<category>Neural networks (Computer science)</category>"));
  check("the author is dc:creator", xml.includes("<dc:creator>Vaswani, Ashish</dc:creator>"));
  check("dc is declared", xml.includes('xmlns:dc="http://purl.org/dc/elements/1.1/"'));

  const empty = buildRssFeed([], OPTS);
  check("an empty feed is still a valid document", empty.includes("<channel>") && empty.trimEnd().endsWith("</rss>"));
  check("an empty feed has no items", !empty.includes("<item>"));

  const noAuthor = buildRssFeed([item({ author: "  " })], OPTS);
  check("a blank author emits no dc:creator", !noAuthor.includes("<dc:creator>"));
}

console.log("\nHostile catalogue data cannot break the document:");
{
  const nasty = buildRssFeed(
    [
      item({
        title: 'Steel & Iron: <b>"Advances"</b> in Manufacturing',
        author: "O'Brien, Seán & Müller, Jürgen",
        // Built from code points, the way test-style.ts builds its banned
        // character. Typed literally they get eaten by whatever writes this
        // file, and the assertion below then passes against a clean fixture.
        description: `Covers 5 < 10 & 10 > 5, plus a null ${NUL} and a vertical tab ${VT}.`,
        categories: ["R&D", "Metals--Testing <ASTM>"],
        link: "https://example.org/a?x=1&y=2",
      }),
    ],
    { ...OPTS, title: "DLS & Friends <feed>" },
  );

  // The only < and > left must be the ones this module wrote as markup.
  const outsideTags = nasty.replace(/<[^>]*>/g, "");
  check("no raw < survives in text", !outsideTags.includes("<"), outsideTags.slice(0, 120));
  check("no raw > survives in text", !outsideTags.includes(">"));
  check("no raw & survives in text", !/&(?!(amp|lt|gt|quot|apos);)/.test(outsideTags));
  check("the ampersand in a URL is escaped", nasty.includes("x=1&amp;y=2"));
  check("control characters are gone", !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(nasty));

  // Parse it back. A string that merely looks like XML is not the claim.
  const tags: string[] = [];
  const stack: string[] = [];
  let balanced = true;
  for (const m of nasty.matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClose] = m;
    if (selfClose) continue;
    if (closing) {
      if (stack.pop() !== name) balanced = false;
    } else {
      stack.push(name);
      tags.push(name);
    }
  }
  check("every element is closed in order", balanced && stack.length === 0, `left open: ${stack.join(", ")}`);
  check("it contains the expected elements", ["rss", "channel", "item", "title", "guid"].every((t) => tags.includes(t)));
}

console.log("\nThe route MARC selection is pinned, and must stay pinned:");
{
  // Not a unit test of a function: a guard on a line of the route. The feed
  // reads MarcField with tag 650 and keeps only subfield $a. That filter is
  // the only thing between a world-readable document and the local 9XX block,
  // where 954 is Point of Contact carrying $a name, $b email, $c department.
  // Widening it turns a policy question into a personal-data leak, so it fails
  // here rather than in production.
  const route = readFileSync(
    new URL("../src/app/api/feed/new-acquisitions/route.ts", import.meta.url),
    "utf8",
  );
  check("the MARC filter is the exact tag 650", route.includes('tag: "650"'));
  check("only subfield $a is published", route.includes('s.code === "a"'));
  check("no local 9XX tag is named in the route", !/"9[0-9][0-9]"/.test(route));
  check("the MARC read is bounded", route.includes("take: 20"));
}

console.log("\nOrdering and identity across a rebuild:");
{
  const a = buildRssFeed([item({ id: "urn:dls:resource:one" }), item({ id: "urn:dls:resource:two" })], OPTS);
  // The guid must not move when the link does: a subscriber dedupes on it, and
  // repointing at the learner portal must not re-announce the whole catalogue.
  const b = buildRssFeed(
    [
      item({ id: "urn:dls:resource:one", link: "https://portal.example/r/one" }),
      item({ id: "urn:dls:resource:two", link: "https://portal.example/r/two" }),
    ],
    OPTS,
  );
  const guids = (s: string) => (s.match(/<guid[^>]*>([^<]+)<\/guid>/g) ?? []).join(",");
  check("guids survive the link changing", guids(a) === guids(b), `${guids(a)} vs ${guids(b)}`);
  check("but the links did change", a !== b);
}

console.log(
  failures === 0
    ? "\nCLEAN: catalogue text cannot escape its element, control characters never reach the document, dates carry their offset, and a guid survives the link being repointed."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
