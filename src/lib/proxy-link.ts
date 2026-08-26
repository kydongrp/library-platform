/**
 * Proxy-prefixed link-out for subscription content.
 *
 * A catalogue record for an IEEE paper links to https://doi.org/10.1109/...,
 * which lands on the publisher's paywall unless the reader arrives through the
 * library's authenticating proxy. This module wraps outbound access links in
 * that proxy at SERVE time. The canonical URL is what the database stores and
 * what the nightly link check tests; the proxied form is what a learner is
 * handed. Storing proxied URLs instead would break dedup on digitalUrl, make
 * the link check test the proxy instead of the target, and turn a proxy
 * migration into a data migration.
 *
 * Configuration, all optional (unset = links pass through unchanged):
 *
 *   PROXY_PREFIX        The proxy's URL pattern. Two forms:
 *                         with a {url} placeholder, it is substituted:
 *                           https://proxy.klsi.example/go?u={url}&x=1
 *                         without one, the target is appended:
 *                           https://proxy.klsi.example/login?url=
 *                       The target is percent-encoded in both forms, which
 *                       EZproxy-style resolvers accept.
 *   PROXY_BYPASS_HOSTS  Comma-separated hosts never wrapped, for open-access
 *                       destinations a strict proxy would refuse. A leading
 *                       dot matches subdomains: ".arxiv.org" matches
 *                       "arxiv.org" and "export.arxiv.org".
 *
 * What gets wrapped: absolute http(s) links on resources that carry a
 * provider. A null provider means the local collection (the schema says so),
 * where digitalUrl may point at internal storage that no proxy knows how to
 * reach. Open-access links stored on subscription records (imports prefer the
 * OA link when one exists) can be exempted per host via the bypass list.
 *
 * Admin screens deliberately keep showing the canonical URL: staff debugging
 * a broken link need the real target, and the proxy is for readers off-site.
 */

/** Parsed form of one PROXY_PREFIX value, memoised per raw string. */
type PrefixConfig = { template: string; origin: string };

const parsed = new Map<string, PrefixConfig | null>();
let warned = false;

function prefixConfig(): PrefixConfig | null {
  const raw = process.env.PROXY_PREFIX?.trim();
  if (!raw) return null;
  const hit = parsed.get(raw);
  if (hit !== undefined) return hit;

  let config: PrefixConfig | null = null;
  try {
    const url = new URL(raw.replace("{url}", ""));
    if (url.protocol === "http:" || url.protocol === "https:") {
      config = { template: raw, origin: url.origin };
    }
  } catch {
    // fall through to the warning below
  }
  if (!config && !warned) {
    // Loud but functional: canonical links still serve, so readers reach the
    // paywalled page rather than an error page, and the log says why.
    console.warn(
      `PROXY_PREFIX is not a usable http(s) URL and is being ignored: ${JSON.stringify(raw)}`,
    );
    warned = true;
  }
  parsed.set(raw, config);
  return config;
}

function bypassHosts(): string[] {
  const raw = process.env.PROXY_BYPASS_HOSTS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function hostBypassed(host: string, entries: string[]): boolean {
  const target = host.toLowerCase();
  return entries.some((entry) =>
    entry.startsWith(".")
      ? target === entry.slice(1) || target.endsWith(entry)
      : target === entry,
  );
}

/** Whether a proxy prefix is configured and valid, for status displays. */
export function proxyConfigured(): boolean {
  return prefixConfig() !== null;
}

/**
 * The link a reader should be handed for a resource's access URL.
 *
 * Returns the input unchanged whenever wrapping would be wrong: no prefix
 * configured, no provider (local collection), a link that is not absolute
 * http(s), a bypassed host, or a link already pointing at the proxy.
 */
export function proxiedUrl(url: string | null, provider: string | null): string | null {
  if (!url) return url;
  const config = prefixConfig();
  if (!config || !provider) return url;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return url; // relative or malformed: nothing a proxy could resolve
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return url;
  if (target.origin === config.origin) return url; // already proxied
  if (hostBypassed(target.hostname, bypassHosts())) return url;

  const encoded = encodeURIComponent(url);
  return config.template.includes("{url}")
    ? config.template.replace("{url}", encoded)
    : config.template + encoded;
}
