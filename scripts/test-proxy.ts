/**
 * Proxy-prefixed link-out: the rules for when a link is wrapped and when it
 * must be left alone.
 *
 *   npx tsx scripts/test-proxy.ts
 *
 * Pure: no database, no network. The failure modes on each side are real.
 * Wrapping too little sends a learner to a paywall; wrapping too much breaks
 * links the proxy cannot resolve, which includes the local collection and
 * open-access hosts a strict proxy refuses.
 */
import { proxiedUrl, proxyConfigured } from "../src/lib/proxy-link";

let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}

function configure(prefix?: string, bypass?: string): void {
  if (prefix === undefined) delete process.env.PROXY_PREFIX;
  else process.env.PROXY_PREFIX = prefix;
  if (bypass === undefined) delete process.env.PROXY_BYPASS_HOSTS;
  else process.env.PROXY_BYPASS_HOSTS = bypass;
}

const DOI = "https://doi.org/10.1109/csics.2016.7751021";
const APPEND = "https://proxy.klsi.example/login?url=";
const PLACEHOLDER = "https://proxy.klsi.example/go?u={url}&session=new";

console.log("Unconfigured, every link passes through unchanged:");
{
  configure(undefined);
  check("reports not configured", !proxyConfigured());
  check("subscription link unchanged", proxiedUrl(DOI, "IEEE Xplore") === DOI);
  check("null stays null", proxiedUrl(null, "IEEE Xplore") === null);
}

console.log("Append form wraps and encodes:");
{
  configure(APPEND);
  check("reports configured", proxyConfigured());
  const out = proxiedUrl(DOI, "IEEE Xplore");
  check("starts with the prefix", out?.startsWith(APPEND) === true, String(out));
  check("target is percent-encoded", out === APPEND + encodeURIComponent(DOI), String(out));
  const withQuery = proxiedUrl("https://example.com/a?b=1&c=2", "JSTOR");
  check(
    "ampersands in the target cannot leak into the proxy's own query",
    withQuery !== null && !withQuery.slice(APPEND.length).includes("&"),
    String(withQuery),
  );
}

console.log("Placeholder form substitutes rather than appends:");
{
  configure(PLACEHOLDER);
  const out = proxiedUrl(DOI, "IEEE Xplore");
  check(
    "lands inside the pattern",
    out === `https://proxy.klsi.example/go?u=${encodeURIComponent(DOI)}&session=new`,
    String(out),
  );
}

console.log("The local collection is never wrapped:");
{
  configure(APPEND);
  check("null provider passes through", proxiedUrl(DOI, null) === DOI);
}

console.log("Links a proxy cannot resolve are left alone:");
{
  configure(APPEND);
  for (const bad of ["/files/local.pdf", "mailto:desk@klsi.example", "ftp://old.host/x", "not a url"]) {
    check(`unchanged: ${JSON.stringify(bad)}`, proxiedUrl(bad, "IEEE Xplore") === bad);
  }
}

console.log("Wrapping is idempotent:");
{
  configure(APPEND);
  const once = proxiedUrl(DOI, "IEEE Xplore")!;
  check("a second pass does not double-wrap", proxiedUrl(once, "IEEE Xplore") === once);
}

console.log("Bypass hosts, for open-access destinations:");
{
  configure(APPEND, "doaj.org, .arxiv.org");
  check("exact host bypassed", proxiedUrl("https://doaj.org/article/x", "IEEE Xplore") === "https://doaj.org/article/x");
  check("subdomain bypassed via dot entry", proxiedUrl("https://export.arxiv.org/abs/1", "IEEE Xplore") === "https://export.arxiv.org/abs/1");
  check("dot entry also matches the bare host", proxiedUrl("https://arxiv.org/abs/1", "IEEE Xplore") === "https://arxiv.org/abs/1");
  check("matching ignores case", proxiedUrl("https://DOAJ.org/article/x", "IEEE Xplore") === "https://DOAJ.org/article/x");
  check("everything else still wraps", proxiedUrl(DOI, "IEEE Xplore")?.startsWith(APPEND) === true);
  check("a bypassed lookalike is not: notdoaj.org", proxiedUrl("https://notdoaj.org/x", "IEEE Xplore")?.startsWith(APPEND) === true);
}

console.log("A malformed prefix disables wrapping instead of breaking links:");
{
  configure("proxy.klsi.example/login?url=");
  check("reports not configured", !proxyConfigured());
  check("does not throw, link unchanged", proxiedUrl(DOI, "IEEE Xplore") === DOI);
  configure("javascript:alert(1)//{url}");
  check("a non-http scheme is refused as a prefix", proxiedUrl(DOI, "IEEE Xplore") === DOI);
}

configure(undefined);
console.log(
  failures === 0
    ? "\nCLEAN: subscription links wrap, everything a proxy cannot resolve passes through."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
