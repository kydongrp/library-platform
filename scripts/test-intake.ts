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
import { portalResourceUrl, portalLinksConfigured } from "../src/lib/portal-links";
import { FETCH_FAILURE_TEXT, REFUSAL_TEXT } from "../src/lib/resource-intake";

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

console.log("\nThe learner-portal link is only offered when its shape is known:");
{
  const withTemplate = (t: string | undefined, fn: () => void) => {
    const before = process.env.PORTAL_RESOURCE_URL;
    if (t === undefined) delete process.env.PORTAL_RESOURCE_URL;
    else process.env.PORTAL_RESOURCE_URL = t;
    try { fn(); } finally {
      if (before === undefined) delete process.env.PORTAL_RESOURCE_URL;
      else process.env.PORTAL_RESOURCE_URL = before;
    }
  };

  withTemplate(undefined, () => {
    check("unset means no link", portalResourceUrl("abc123") === null);
    check("and reports itself as unconfigured", !portalLinksConfigured());
  });

  withTemplate("https://portal.example/resources/{id}", () => {
    check("a path template is filled", portalResourceUrl("abc123") === "https://portal.example/resources/abc123");
    check("and reports itself as configured", portalLinksConfigured());
    check("an empty id yields nothing", portalResourceUrl("") === null);
    check("a whitespace id yields nothing", portalResourceUrl("   ") === null);
  });

  withTemplate("https://portal.example/item?id={id}", () => {
    check(
      "a query template works too",
      portalResourceUrl("abc123") === "https://portal.example/item?id=abc123",
      portalResourceUrl("abc123") ?? "null",
    );
  });

  // A template with no placeholder would give every record the same URL.
  withTemplate("https://portal.example/resources", () => {
    check("a template without {id} is refused", portalResourceUrl("abc") === null);
  });
  // Anything not http(s) would be handed to a browser as a link.
  withTemplate("javascript:alert({id})", () => {
    check("a javascript: template is refused", portalResourceUrl("abc") === null);
  });
  withTemplate("portal.example/{id}", () => {
    check("a schemeless template is refused", portalResourceUrl("abc") === null);
  });

  withTemplate("https://portal.example/r/{id}", () => {
    // An id is a cuid in practice, but encoding means a template is safe even
    // if that ever changes.
    check(
      "an id is percent-encoded",
      portalResourceUrl("a/b c")?.includes("a%2Fb%20c") === true,
      portalResourceUrl("a/b c") ?? "null",
    );
  });
}

console.log("\nEvery fetch failure has wording a librarian can act on:");
{
  const reasons = [
    "blocked", "scheme", "port", "timeout", "too-many-hops",
    "network", "status", "content-type", "no-location",
  ] as const;
  for (const r of reasons) {
    const text = FETCH_FAILURE_TEXT[r];
    check(`${r} has wording`, typeof text === "string" && text.length > 10, text);
    check(`${r} avoids jargon`, !text.includes("_") && !/[A-Z]{4,}/.test(text), text);
  }
}

console.log("\nRefused outright vs saved-but-flagged:");
{
  // The distinction decides whether a catalogue record is created at all. A
  // site being down is a temporary fact about the world and still deserves a
  // record to fix later; a link resolving to a private address is a permanent
  // fact about the link, and cataloguing it would put the cloud metadata
  // endpoint in the library and hand that link to a reader.
  const refused = Object.keys(REFUSAL_TEXT).sort();
  check(
    "exactly blocked, port and scheme are refused",
    refused.join(",") === "blocked,port,scheme",
    refused.join(","),
  );

  const saved = ["timeout", "too-many-hops", "network", "status", "content-type", "no-location"];
  for (const r of saved) {
    check(`${r} is NOT a refusal, so a record is still created`, !(r in REFUSAL_TEXT));
  }
  for (const r of refused) {
    check(
      `${r} explains why it is permanent`,
      REFUSAL_TEXT[r as keyof typeof REFUSAL_TEXT].length > 20,
    );
  }
  // Every reason is covered by one map or the other, so a new FetchFailure
  // cannot fall through with no wording at all.
  const all = ["blocked", "scheme", "port", "timeout", "too-many-hops",
               "network", "status", "content-type", "no-location"];
  check(
    "every failure has wording somewhere",
    all.every((r) => r in REFUSAL_TEXT || r in FETCH_FAILURE_TEXT),
  );
}

console.log(
  failures === 0
    ? "\nCLEAN: only http(s) links become submissions, and duplicate detection survives tracking parameters without merging distinct articles."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
