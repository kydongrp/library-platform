/**
 * Pure logic for external resource intake: no network, no database, no env.
 *
 * A member of staff has a link on their phone and wants it in the catalogue.
 * This module decides what they actually sent, and nothing else, which is what
 * makes it testable (scripts/test-intake.ts).
 *
 * Deliberately channel-agnostic. It began life behind a WhatsApp webhook and
 * now sits behind an authenticated web form; the only thing that changed was
 * the transport, because "what did the sender mean" never depended on it.
 */

export type Submission =
  | { kind: "url"; value: string }
  | { kind: "doi"; value: string }
  | { kind: "empty" };

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;

/**
 * Characters that commonly trail a pasted link in prose but are not part of
 * it. Closing brackets are only stripped when unbalanced, so a Wikipedia-style
 * URL ending in ")" survives.
 */
function trimTrailingPunctuation(url: string): string {
  let out = url;
  for (;;) {
    const last = out.at(-1);
    if (!last) break;
    if (".,;:!?’'\"".includes(last)) {
      out = out.slice(0, -1);
      continue;
    }
    if (last === ")" || last === "]" || last === "}") {
      const open = last === ")" ? "(" : last === "]" ? "[" : "{";
      const opens = out.split(open).length - 1;
      const closes = out.split(last).length - 1;
      if (closes > opens) {
        out = out.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return out;
}

/**
 * Read whatever the sender pasted.
 *
 * Permissive about surrounding text, because a phone's share sheet often hands
 * over "Some Article Title https://…" in one blob. Strict about the scheme:
 * only http and https, so "javascript:", "file:" and "data:" can never reach
 * the fetcher. A bare "www." host is upgraded to https rather than rejected,
 * and a bare DOI is recognised because Crossref resolves those with no page
 * fetch at all, which is both faster and safer than fetching.
 */
export function parseSubmission(text: string | null | undefined): Submission {
  if (!text || typeof text !== "string") return { kind: "empty" };
  const trimmed = text.trim();
  if (!trimmed) return { kind: "empty" };

  // An explicit http(s) link wins: it is what the sender actually chose.
  const explicit = trimmed.match(/https?:\/\/[^\s<>"']+/i);
  if (explicit) {
    const url = trimTrailingPunctuation(explicit[0]);
    return isUsableHttpUrl(url) ? { kind: "url", value: url } : { kind: "empty" };
  }

  const doi = trimmed.match(DOI_RE);
  if (doi) return { kind: "doi", value: trimTrailingPunctuation(doi[1]) };

  const bare = trimmed.match(/\bwww\.[^\s<>"']+/i);
  if (bare) {
    const url = `https://${trimTrailingPunctuation(bare[0])}`;
    return isUsableHttpUrl(url) ? { kind: "url", value: url } : { kind: "empty" };
  }

  return { kind: "empty" };
}

/**
 * A URL this system is willing to fetch and store.
 *
 * Scheme and shape only. Whether the host is safe to REACH is a separate
 * question answered by isBlockedHost in src/lib/net.ts and, decisively, by the
 * DNS lookup hook in src/lib/page-fetch.ts. Callers must apply those too;
 * keeping the concerns apart is what lets this function stay pure.
 */
export function isUsableHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (!u.hostname) return false;
  // A hostname with no dot is either a local alias or a typo; either way it is
  // not a public resource worth a catalogue record.
  if (!u.hostname.includes(".")) return false;
  // Credentials in a URL would be stored in the catalogue and handed to
  // learners. Refuse rather than silently strip.
  if (u.username || u.password) return false;
  return true;
}

/**
 * The canonical form used for duplicate detection.
 *
 * Resource.digitalUrl is @unique, so this decides what counts as "already in
 * the library". Two people sharing the same article from different apps should
 * collide, so tracking parameters and a trailing slash must not defeat it.
 * Conservative on purpose: only parameters that are unambiguously analytics
 * are dropped, because a query string is load-bearing on plenty of sites
 * (?id=, ?doi=, ?articleId=) and over-normalising would merge two real records.
 */
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "gclid", "fbclid", "mc_cid", "mc_eid", "igshid", "ref_src", "ref_url", "_ga",
]);

export function canonicaliseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.trim();
  }
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, "");
  // Default ports are noise; an explicit :443 must match a bare https URL.
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) {
    u.port = "";
  }
  for (const p of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
  }
  // A fragment addresses a place within one document, not a different one.
  u.hash = "";
  // "https://host" and "https://host/" are the same page.
  if (u.pathname === "/") u.pathname = "";
  let out = u.toString();
  if (out.endsWith("?")) out = out.slice(0, -1);
  return out;
}
