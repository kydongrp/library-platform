/**
 * External resource intake: the pure decisions.
 *
 *   npx tsx scripts/test-intake.ts
 *
 * Pure: no database, no network. Each side has a real failure mode.
 *
 * A URL parser that is too permissive hands the server-side fetcher a "file:"
 * or "javascript:" target. A canonicaliser that is too eager merges two
 * genuinely different articles into one catalogue record; one that is too timid
 * lets the same article in twice because someone shared it from an app that
 * appends tracking parameters.
 */
import {
  parseSubmission,
  isUsableHttpUrl,
  canonicaliseUrl,
} from "../src/lib/submission-core";

let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}

console.log("Parsing finds the link people actually sent:");
{
  const u = (t: string) => {
    const s = parseSubmission(t);
    return s.kind === "url" ? s.value : `(${s.kind})`;
  };
  check("a bare url", u("https://arxiv.org/abs/2401.00001") === "https://arxiv.org/abs/2401.00001");
  check(
    "a url inside a sentence",
    u("please add this https://arxiv.org/abs/2401.00001 thanks") === "https://arxiv.org/abs/2401.00001",
  );
  // A phone share sheet hands over "Title <newline> URL" as one blob.
  check(
    "a share-sheet blob with the title first",
    u("Attention Is All You Need\nhttps://arxiv.org/abs/1706.03762") === "https://arxiv.org/abs/1706.03762",
  );
  check(
    "a trailing full stop is not part of the url",
    u("add https://arxiv.org/abs/2401.00001.") === "https://arxiv.org/abs/2401.00001",
  );
  check(
    "a trailing comma is not part of the url",
    u("https://arxiv.org/abs/2401.00001, thanks") === "https://arxiv.org/abs/2401.00001",
  );
  check(
    "a balanced bracket in the url survives",
    u("https://en.wikipedia.org/wiki/Foo_(bar)") === "https://en.wikipedia.org/wiki/Foo_(bar)",
  );
  check(
    "an unbalanced closing bracket is trimmed",
    u("(see https://arxiv.org/abs/2401.00001)") === "https://arxiv.org/abs/2401.00001",
  );
  check("a query string survives", u("https://x.com/a?b=1&c=2") === "https://x.com/a?b=1&c=2");
  check("http is accepted", u("http://example.com/a") === "http://example.com/a");
  check("www is upgraded to https", u("www.example.com/a") === "https://www.example.com/a");
  check("the first url wins", u("https://a.com/1 and https://b.com/2") === "https://a.com/1");

  check("empty text", parseSubmission("").kind === "empty");
  check("whitespace only", parseSubmission("   \n ").kind === "empty");
  check("null", parseSubmission(null).kind === "empty");
  check("undefined", parseSubmission(undefined).kind === "empty");
  check("prose with no link", parseSubmission("can you add the new IEEE paper").kind === "empty");

  const doi = parseSubmission("10.1109/CSICS.2016.7751021");
  check("a bare DOI is recognised", doi.kind === "doi" && doi.value === "10.1109/CSICS.2016.7751021");
  const doiInProse = parseSubmission("doi 10.1145/3292500.3330701 please");
  check(
    "a DOI in prose is recognised",
    doiInProse.kind === "doi" && doiInProse.value === "10.1145/3292500.3330701",
  );
  check(
    "a doi.org URL is read as a url, not a bare doi",
    parseSubmission("https://doi.org/10.1109/x").kind === "url",
  );
}

console.log("\nDangerous schemes and shapes never become a submission:");
{
  for (const bad of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>alert(1)</script>",
    "ftp://example.com/x",
    "gopher://example.com",
    "vbscript:msgbox(1)",
  ]) {
    check(`"${bad.slice(0, 28)}" is not a url submission`, parseSubmission(bad).kind !== "url");
  }
  check("a scheme-only string is refused", !isUsableHttpUrl("https://"));
  check("a hostless url is refused", !isUsableHttpUrl("https:///path"));
  check("a dotless host is refused", !isUsableHttpUrl("http://localhost/x"));
  check("a dotless host in a message is refused", parseSubmission("http://intranet/x").kind !== "url");
  check("embedded credentials are refused", !isUsableHttpUrl("https://user:pass@example.com/x"));
  check(
    "embedded credentials in a message are refused",
    parseSubmission("https://admin:hunter2@example.com/x").kind !== "url",
  );
  check("a relative path is refused", !isUsableHttpUrl("/admin/catalogue"));
  check("nonsense is refused", !isUsableHttpUrl("not a url at all"));
  // Scheme and shape only. Reaching the host is isBlockedHost's and the DNS
  // lookup hook's job, and this asserts the split is deliberate.
  check(
    "a private IP passes the SHAPE check (reachability is page-fetch's job)",
    isUsableHttpUrl("http://169.254.169.254/latest/meta-data/"),
  );
}

console.log("\nCanonicalisation decides what counts as already in the library:");
{
  const c = canonicaliseUrl;
  const target = "https://arxiv.org/abs/1706.03762";
  check("identical urls match", c(target) === c(target));
  check("scheme case is normalised", c("HTTPS://arxiv.org/abs/1") === c("https://arxiv.org/abs/1"));
  check("host case is normalised", c("https://ArXiv.ORG/abs/1") === c("https://arxiv.org/abs/1"));
  check("a trailing root slash is ignored", c("https://arxiv.org/") === c("https://arxiv.org"));
  check("a default https port is ignored", c("https://arxiv.org:443/abs/1") === c("https://arxiv.org/abs/1"));
  check("a default http port is ignored", c("http://arxiv.org:80/abs/1") === c("http://arxiv.org/abs/1"));
  check("a fragment is ignored", c(`${target}#section-3`) === c(target));
  check(
    "utm parameters are dropped",
    c(`${target}?utm_source=twitter&utm_medium=social`) === c(target),
    `got ${c(`${target}?utm_source=twitter&utm_medium=social`)}`,
  );
  check("fbclid is dropped", c(`${target}?fbclid=abc123`) === c(target));
  check("gclid is dropped", c(`${target}?gclid=abc123`) === c(target));
  check(
    "a mix of tracking and real parameters keeps the real one",
    c("https://x.com/a?id=42&utm_source=t") === c("https://x.com/a?id=42"),
  );

  // Over-normalising is the worse failure: it merges two real articles.
  check(
    "a meaningful query parameter is NOT dropped",
    c("https://x.com/view?id=1") !== c("https://x.com/view?id=2"),
  );
  check("a different path is not merged", c("https://x.com/a") !== c("https://x.com/b"));
  check("a different host is not merged", c("https://a.com/x") !== c("https://b.com/x"));
  check(
    "http and https are NOT merged (different origins)",
    c("http://x.com/a") !== c("https://x.com/a"),
  );
  check(
    "a non-root trailing slash is NOT stripped",
    c("https://x.com/a/") !== c("https://x.com/a"),
  );
  check("a non-default port is kept", c("https://x.com:8443/a") !== c("https://x.com/a"));
  check("garbage does not throw", c("not a url") === "not a url");
  check("empty does not throw", c("") === "");
}

console.log(
  failures === 0
    ? "\nCLEAN: only http(s) links become submissions, and duplicate detection survives tracking parameters without merging distinct articles."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
