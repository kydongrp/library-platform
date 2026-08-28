/**
 * URL metadata extraction: which claim about a page wins.
 *
 *   npx tsx scripts/test-metadata.ts
 *
 * Pure: no network. Precedence is the whole substance of this module, and
 * precedence regresses silently. A publisher's citation_* tags must beat an
 * Open Graph title, because og:title is often the site's marketing headline
 * ("Read the full paper | IEEE Xplore") while citation_title is the actual
 * work. Getting that backwards produces a catalogue full of plausible rubbish
 * that nobody notices until a learner searches for a real title.
 */
import {
  parseHtmlMetadata,
  metaTags,
  yearOf,
  resourceTypeFrom,
  titleFromUrl,
  decodeEntities,
} from "../src/lib/url-metadata";

let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}

console.log("Meta tags are collected however they are written:");
{
  const html = `
    <meta name="citation_title" content="A Paper">
    <meta content="Jane Doe" name="citation_author">
    <meta property="og:title" content="Marketing Headline">
    <meta name='citation_author' content='John Roe'>
    <META NAME="DC.Title" CONTENT="Upper Case Tag">
    <meta name="broken">
    <meta content="orphan">
  `;
  const tags = metaTags(html);
  check("name= is read", tags.get("citation_title")?.[0] === "A Paper");
  check("content before name is read", tags.get("citation_author")?.[0] === "Jane Doe");
  check("property= is read", tags.get("og:title")?.[0] === "Marketing Headline");
  check("single quotes are read", tags.get("citation_author")?.[1] === "John Roe");
  check("repeated tags accumulate in order", tags.get("citation_author")?.length === 2);
  check("tag names are lowercased", tags.get("dc.title")?.[0] === "Upper Case Tag");
  check("a tag with no content is skipped", !tags.has("broken"));
  check("a tag with no name is skipped", tags.size === 4, `size ${tags.size}`);
}

console.log("\nPublisher citation_* tags beat Open Graph:");
{
  const html = `
    <title>Read the full paper | IEEE Xplore</title>
    <meta property="og:title" content="Read the full paper | IEEE Xplore">
    <meta property="og:site_name" content="IEEE Xplore">
    <meta name="citation_title" content="Attention Is All You Need">
    <meta name="citation_author" content="Vaswani, Ashish">
    <meta name="citation_author" content="Shazeer, Noam">
    <meta name="citation_journal_title" content="Advances in Neural Information Processing Systems">
    <meta name="citation_publisher" content="IEEE">
    <meta name="citation_publication_date" content="2017/12/04">
    <meta name="citation_doi" content="10.1109/EXAMPLE.2017.1234">
  `;
  const m = parseHtmlMetadata(html);
  check("citation_title wins", m.title === "Attention Is All You Need", `got ${m.title}`);
  check("source is recorded as citation", m.source === "citation");
  check("multiple authors are joined", m.authors === "Vaswani, Ashish; Shazeer, Noam", `got ${m.authors}`);
  check("venue comes from the journal title", m.venue?.startsWith("Advances in") === true);
  check("publisher is read", m.publisher === "IEEE");
  check("year is parsed from a slashed date", m.year === 2017, `got ${m.year}`);
  check("doi is extracted", m.doi === "10.1109/EXAMPLE.2017.1234", `got ${m.doi}`);
}

console.log("\nDublin Core is used when citation_* is absent:");
{
  const html = `
    <title>Repository</title>
    <meta name="DC.title" content="A Thesis On Something">
    <meta name="DC.creator" content="A Student">
    <meta name="DC.creator" content="A Supervisor">
    <meta name="DC.date" content="2019-06-01">
    <meta name="DC.publisher" content="Some University">
    <meta name="DC.type" content="Thesis">
    <meta name="DC.identifier" content="doi:10.9999/thesis.42">
  `;
  const m = parseHtmlMetadata(html);
  check("dc.title is used", m.title === "A Thesis On Something");
  check("source is dublin-core", m.source === "dublin-core");
  check("dc creators are joined", m.authors === "A Student; A Supervisor");
  check("iso date yields the year", m.year === 2019);
  check("dc.publisher is used", m.publisher === "Some University");
  check("Thesis maps to EBOOK", m.type === "EBOOK", `got ${m.type}`);
  check("a doi inside dc.identifier is found", m.doi === "10.9999/thesis.42", `got ${m.doi}`);
}

console.log("\nJSON-LD is used when meta tags are absent:");
{
  const html = `
    <title>News Site</title>
    <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"NewsArticle",
     "headline":"Something Happened Today",
     "author":{"@type":"Person","name":"A Reporter"},
     "datePublished":"2026-03-04T10:00:00Z",
     "publisher":{"@type":"Organization","name":"The Daily Example"},
     "description":"A short summary."}
    </script>
  `;
  const m = parseHtmlMetadata(html);
  check("headline is used", m.title === "Something Happened Today");
  check("source is json-ld", m.source === "json-ld");
  check("a nested author name is read", m.authors === "A Reporter", `got ${m.authors}`);
  check("a nested publisher name is read", m.publisher === "The Daily Example");
  check("an ISO timestamp yields the year", m.year === 2026);
  check("description becomes the abstract", m.abstract === "A short summary.");
  check("NewsArticle maps to NEWSPAPER", m.type === "NEWSPAPER", `got ${m.type}`);
}

console.log("\nJSON-LD shapes that would break a naive parser:");
{
  const graph = `<script type="application/ld+json">
    {"@graph":[{"@type":"WebSite","name":"Site"},{"@type":"ScholarlyArticle","headline":"Inside A Graph"}]}
  </script>`;
  check("an @graph wrapper is walked", parseHtmlMetadata(graph).title === "Inside A Graph");

  const arr = `<script type="application/ld+json">
    [{"@type":"BreadcrumbList"},{"@type":"Article","headline":"Inside An Array"}]
  </script>`;
  check("a top-level array is walked", parseHtmlMetadata(arr).title === "Inside An Array");

  const authors = `<script type="application/ld+json">
    {"@type":"Article","headline":"Many Authors","author":[{"name":"One"},{"name":"Two"}]}
  </script>`;
  check(
    "an author array is joined",
    parseHtmlMetadata(authors).authors === "One, Two",
    parseHtmlMetadata(authors).authors ?? "null",
  );

  const bad = `<script type="application/ld+json">{ not json at all }</script>
    <title>Fell Back</title>`;
  const m = parseHtmlMetadata(bad);
  check("malformed json-ld does not throw and falls through", m.title === "Fell Back");

  // A page routinely ships an Organization or WebSite node alongside the
  // article. Its `name` must never beat the article's `headline`, even when it
  // appears first in the document.
  const many = `<script type="application/ld+json">{"@type":"Organization","name":"Org"}</script>
    <script type="application/ld+json">{"@type":"Article","headline":"The Real One"}</script>`;
  check(
    "an Article headline beats an earlier Organization name",
    parseHtmlMetadata(many).title === "The Real One",
    parseHtmlMetadata(many).title ?? "null",
  );
  const siteFirst = `<script type="application/ld+json">
    {"@graph":[{"@type":"WebSite","name":"IEEE Xplore"},
               {"@type":"ScholarlyArticle","headline":"The Actual Paper","author":{"name":"A Author"}}]}
  </script>`;
  const sf = parseHtmlMetadata(siteFirst);
  check("a WebSite name does not become the title", sf.title === "The Actual Paper", sf.title ?? "null");
  check("the author comes from the article node", sf.authors === "A Author", sf.authors ?? "null");
  check(
    "the site name is still a fair guess at the publisher",
    sf.publisher === "IEEE Xplore" || sf.publisher === null,
    sf.publisher ?? "null",
  );

  // Two articles: document order decides, not sort instability.
  const twoArticles = `<script type="application/ld+json">{"@type":"Article","headline":"First"}</script>
    <script type="application/ld+json">{"@type":"Article","headline":"Second"}</script>`;
  check("the first article wins", parseHtmlMetadata(twoArticles).title === "First");
}

console.log("\nOpen Graph, then <title>, then nothing:");
{
  const og = `<title>Doc Title</title><meta property="og:title" content="OG Title">`;
  const m1 = parseHtmlMetadata(og);
  check("og:title beats <title>", m1.title === "OG Title" && m1.source === "open-graph");

  const t = `<title>  Just   A  Title  </title>`;
  const m2 = parseHtmlMetadata(t);
  check("<title> is used and whitespace collapsed", m2.title === "Just A Title", `got ${m2.title}`);
  check("source is title", m2.source === "title");

  const none = `<html><body><p>nothing useful</p></body></html>`;
  const m3 = parseHtmlMetadata(none);
  check("an empty page yields no title", m3.title === null);
  check("source is none", m3.source === "none");

  const empty = parseHtmlMetadata("");
  check("empty html does not throw", empty.title === null && empty.source === "none");
}

console.log("\nEntities are decoded:");
{
  check("named entities", decodeEntities("A &amp; B &quot;C&quot;") === 'A & B "C"');
  check("numeric entities", decodeEntities("caf&#233;") === "café");
  check("hex entities", decodeEntities("caf&#xe9;") === "café");
  check("unknown entities survive", decodeEntities("&zzz;") === "&zzz;");
  const html = `<meta name="citation_title" content="Bayes&#39; Theorem &amp; You">`;
  check(
    "a title is decoded",
    parseHtmlMetadata(html).title === "Bayes' Theorem & You",
    parseHtmlMetadata(html).title ?? "null",
  );
}

console.log("\nYear parsing is forgiving but bounded:");
{
  check("iso date", yearOf("2019-06-01") === 2019);
  check("slashed date", yearOf("2017/12/04") === 2017);
  check("year only", yearOf("1998") === 1998);
  check("prose", yearOf("published in 2005 by someone") === 2005);
  check("timestamp", yearOf("2026-03-04T10:00:00Z") === 2026);
  check("no year", yearOf("no digits here") === null);
  check("null input", yearOf(null) === null);
  check("a page-view count is not a year", yearOf("12345 views") === null);
  check("a far-future year is refused", yearOf("2999") === null);
  check("an early year is refused", yearOf("1000") === null);
}

console.log("\nType mapping is conservative:");
{
  check("proceedings", resourceTypeFrom("Proceedings Article") === "CONFERENCE");
  check("standard", resourceTypeFrom("standard") === "STANDARD");
  check("journal", resourceTypeFrom("journal-article") === "JOURNAL");
  check("ScholarlyArticle", resourceTypeFrom("ScholarlyArticle") === "JOURNAL");
  check("magazine", resourceTypeFrom("Magazine") === "MAGAZINE");
  check("NewsArticle", resourceTypeFrom("NewsArticle") === "NEWSPAPER");
  check("book", resourceTypeFrom("Book") === "EBOOK");
  check("thesis", resourceTypeFrom("Thesis") === "EBOOK");
  check("an unknown word yields null, not a guess", resourceTypeFrom("website") === null);
  check("null input", resourceTypeFrom(null) === null);
}

console.log("\nA URL always yields something a human recognises:");
{
  check(
    "a slug becomes words",
    titleFromUrl("https://example.com/blog/how-to-catalogue-things") === "How to catalogue things",
    titleFromUrl("https://example.com/blog/how-to-catalogue-things"),
  );
  check(
    "an extension is dropped",
    titleFromUrl("https://example.com/docs/annual-report.html") === "Annual report",
  );
  check(
    "underscores become spaces",
    titleFromUrl("https://example.com/some_useful_paper") === "Some useful paper",
  );
  check(
    "percent-encoding is decoded",
    titleFromUrl("https://example.com/caf%C3%A9-review") === "Café review",
    titleFromUrl("https://example.com/caf%C3%A9-review"),
  );
  check(
    "a numeric slug falls back to the host",
    titleFromUrl("https://arxiv.org/abs/1706.03762") === "arxiv.org",
    titleFromUrl("https://arxiv.org/abs/1706.03762"),
  );
  check("a bare host uses the host", titleFromUrl("https://www.example.com/") === "example.com");
  check("garbage does not throw", titleFromUrl("not a url").length > 0);
}

console.log(
  failures === 0
    ? "\nCLEAN: publisher metadata beats marketing headlines, malformed markup falls through instead of throwing, and every page yields a recognisable title."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
