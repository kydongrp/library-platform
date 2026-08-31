/**
 * Check whether a URL serves a DOCUMENT, by reading the body.
 *
 *   npx tsx scripts/verify-acquisition-links.ts <accepted.json> [out.json]
 *   npx tsx scripts/verify-acquisition-links.ts --url https://... "Expected Title"
 *
 * src/lib/link-state.ts states the limit this exists to cover:
 *
 *   "Classified from the HTTP status. A 200 carrying a challenge page would
 *    still read as resolved."
 *
 * The nightly access scan records status codes, which is the right rule for
 * deciding whether a link is DEAD and the wrong one for deciding whether a
 * reader gets the document. Measured against a 42-title acquisitions list on
 * 31 August 2026, every entry carried a stored 200 and four served nothing:
 *
 *   755 bytes    a DSpace /handle/ page: an empty single-page-app shell
 *   403 + 200    a Cloudflare "Just a moment..." interstitial
 *   244 bytes    an F5 "Request Rejected" page, served with status 200
 *
 * So this fetches the body and decides on what came back. It is a cataloguing
 * gate, not a monitor: run it before a link enters the catalogue, where a wrong
 * answer is cheap to act on. Nothing here writes to the database.
 *
 * VERDICTS
 *   DOCUMENT       a PDF, or HTML that contains the title's distinctive words
 *   SHELL          200 with too little content to be the document
 *   CHALLENGE      an interstitial, named as such in its own <title>
 *   NOT_DELIVERED  202/401/403/429: answered, did not hand over the document.
 *                  Matches link-state.ts: a subscription wall is the system
 *                  working, not a broken link, and is a decision not a failure
 *   DEAD           404, 410, 5xx, or no response
 *   ERROR          the check itself could not complete, which is not a verdict
 *                  about the link and must not be read as one
 */
import { readFileSync, writeFileSync } from "node:fs";

const CONCURRENCY = 6;
const READ_CAP = 1024 * 1024;
const TIMEOUT_MS = 30_000;
const SHELL_BYTES = 4096;
const MIN_PDF_BYTES = 10_000;

/**
 * A browser's User-Agent, because the question this asks is "can a reader open
 * this", not "can a crawler". Several publishers serve a challenge to anything
 * that looks automated while serving the document to a person, and a library
 * cataloguing a link cares about the person.
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/**
 * Matched against the TITLE, never the body.
 *
 * A body scan for these strings false-positived on rand.org: the word "captcha"
 * appears in invisible markup on a page that is unmistakably the real document,
 * correct heading, every title word present, a direct PDF link and a DOI. A
 * page that loads a captcha widget for a newsletter signup is not withholding
 * itself. A challenge page says so in its title.
 */
const CHALLENGE_TITLES = [
  "just a moment",
  "attention required",
  "checking your browser",
  "access denied",
  "request rejected",
  "are you a robot",
  "security check",
  "403 forbidden",
];

export type Verdict = "DOCUMENT" | "SHELL" | "CHALLENGE" | "NOT_DELIVERED" | "DEAD" | "ERROR";

export type Result = {
  n: number;
  title: string;
  url: string;
  finalUrl: string;
  status: number | null;
  contentType: string;
  bytes: number;
  kind: string;
  htmlTitle: string | null;
  pdfTitle: string | null;
  titleWordsMatched: string | null;
  verdict: Verdict;
  note: string;
};

type Incoming = { title: string; url: string };

/** Words worth matching on: short and common ones make a match meaningless. */
function distinctiveWords(title: string): string[] {
  const stop = new Set([
    "the", "a", "an", "and", "or", "of", "for", "in", "on", "to", "with", "from",
    "into", "at", "by", "as", "is", "are", "be", "vol", "no", "version", "issues",
    "background", "department", "standard", "method", "test", "report", "review",
  ]);
  return [
    ...new Set(
      title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 5 && !stop.has(w)),
    ),
  ].slice(0, 8);
}

export async function checkUrl(item: Incoming, n = 1): Promise<Result> {
  const r: Result = {
    n,
    title: item.title,
    url: item.url,
    finalUrl: item.url,
    status: null,
    contentType: "",
    bytes: 0,
    kind: "",
    htmlTitle: null,
    pdfTitle: null,
    titleWordsMatched: null,
    verdict: "ERROR",
    note: "",
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(item.url, {
      redirect: "follow",
      signal: ac.signal,
      headers: { "User-Agent": UA, Accept: "*/*", "Accept-Language": "en-GB,en;q=0.9" },
    });
    r.status = res.status;
    r.finalUrl = res.url;
    r.contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();

    const buf = new Uint8Array(await res.arrayBuffer());
    r.bytes = buf.length;
    const body = buf.length > READ_CAP ? buf.subarray(0, READ_CAP) : buf;
    const magic = new TextDecoder("latin1").decode(body.subarray(0, 8));
    const text = new TextDecoder("utf-8", { fatal: false }).decode(body);

    if (magic.startsWith("%PDF")) {
      r.kind = "pdf";
      // /Title in the info dict is often uncompressed. When present it is free
      // corroboration, but it is NOT decisive: the first /Title in a file can
      // belong to an embedded object. On NIST.FIPS.203.pdf it reads "Seal of
      // the United States Department of Commerce".
      const m = text.match(/\/Title\s*\(([^)]{3,200})\)/);
      r.pdfTitle = m ? m[1].replace(/\\(.)/g, "$1").trim() : null;
    } else if (r.contentType.includes("html") || text.slice(0, 2000).toLowerCase().includes("<html")) {
      r.kind = "html";
      const m = text.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
      r.htmlTitle = m ? m[1].replace(/\s+/g, " ").trim() : null;
      const visible = text
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .toLowerCase();
      const words = distinctiveWords(item.title);
      const seen = words.filter((w) => visible.includes(w));
      r.titleWordsMatched = `${seen.length}/${words.length}`;

      const t = (r.htmlTitle ?? "").toLowerCase();
      if (CHALLENGE_TITLES.some((c) => t.includes(c))) {
        r.verdict = "CHALLENGE";
        r.note = `HTTP ${res.status} carrying "${r.htmlTitle}", not the document`;
        return r;
      }
      if (buf.length < SHELL_BYTES) {
        r.verdict = "SHELL";
        r.note = `only ${buf.length} bytes of HTML`;
        return r;
      }
      if (words.length >= 3 && seen.length === 0) {
        r.verdict = "SHELL";
        r.note = "page text contains none of the title's distinctive words";
        return r;
      }
    } else {
      r.kind = r.contentType || "unknown";
    }

    if (res.status === 404 || res.status === 410 || res.status >= 500) {
      r.verdict = "DEAD";
      r.note = `HTTP ${res.status}`;
    } else if ([202, 401, 403, 429].includes(res.status)) {
      r.verdict = "NOT_DELIVERED";
      r.note = `HTTP ${res.status}: answered, did not hand over the document`;
    } else if (r.kind === "pdf" && buf.length < MIN_PDF_BYTES) {
      r.verdict = "SHELL";
      r.note = `PDF is only ${buf.length} bytes`;
    } else if (!res.ok) {
      r.verdict = "DEAD";
      r.note = `HTTP ${res.status}`;
    } else {
      r.verdict = "DOCUMENT";
      r.note = `${Math.round(buf.length / 1024)} KB ${r.kind === "pdf" ? "PDF" : r.kind === "html" ? "HTML" : r.kind}`;
    }
  } catch (e) {
    r.verdict = "ERROR";
    r.note = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 140) : String(e);
  } finally {
    clearTimeout(timer);
  }
  return r;
}

void (async () => {
  const argv = process.argv.slice(2);
  let items: Incoming[];
  let out: string | undefined;

  if (argv[0] === "--url") {
    if (!argv[1]) {
      console.error('Usage: verify-acquisition-links.ts --url <url> ["Expected Title"]');
      process.exit(1);
    }
    items = [{ url: argv[1], title: argv[2] ?? "" }];
  } else {
    if (!argv[0]) {
      console.error("Usage: verify-acquisition-links.ts <accepted.json> [out.json]");
      process.exit(1);
    }
    const parsed = JSON.parse(readFileSync(argv[0], "utf8")) as
      | { accepted?: Incoming[] }
      | Incoming[];
    items = Array.isArray(parsed) ? parsed : (parsed.accepted ?? []);
    out = argv[1];
  }

  console.log(`checking ${items.length} URL(s) by body, ${CONCURRENCY} at a time\n`);

  const results: Result[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        const r = await checkUrl(items[i], i + 1);
        results.push(r);
        console.log(
          `  ${r.verdict === "DOCUMENT" ? "ok  " : "**  "}${String(r.n).padStart(2)}. ` +
            `${r.verdict.padEnd(14)} ${(r.title || r.url).slice(0, 46).padEnd(46)} ${r.note}`,
        );
      }
    }),
  );

  results.sort((a, b) => a.n - b.n);
  const tally = new Map<string, number>();
  for (const r of results) tally.set(r.verdict, (tally.get(r.verdict) ?? 0) + 1);
  console.log(`\nverdicts:`);
  for (const [v, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${v}`);

  const bad = results.filter((r) => r.verdict !== "DOCUMENT");
  if (bad.length) {
    console.log(`\n${bad.length} did not serve a document:\n`);
    for (const r of bad) {
      console.log(`  ${r.n}. ${(r.title || "(no title given)").slice(0, 70)}`);
      console.log(`     ${r.verdict}: ${r.note}`);
      console.log(`     url    ${r.url}`);
      if (r.finalUrl !== r.url) console.log(`     final  ${r.finalUrl}`);
      console.log(
        `     ${r.status ?? "-"} ${r.contentType || "-"} ${r.bytes}b` +
          `  htmlTitle=${r.htmlTitle ?? "-"}  titleWords=${r.titleWordsMatched ?? "-"}`,
      );
      console.log();
    }
  }

  if (out) {
    writeFileSync(out, JSON.stringify(results, null, 1), "utf8");
    console.log(`wrote ${out}`);
  }
  // Non-zero when anything failed, so this can gate a cataloguing run.
  process.exit(bad.length === 0 ? 0 : 1);
})();
