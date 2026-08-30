/**
 * Library of Congress Subject Headings lookup.
 *
 * The catalogue had no subject metadata at all: every MARC 650 empty, no
 * authority records, and 40 of 62 titles filed under the single category
 * "Technology". Subject access was whatever a keyword search could find in a
 * title string.
 *
 * The temptation when filling that gap is to invent a vocabulary. A local list
 * is quick, reads plausibly, and is worth nothing outside this system: it
 * cannot be reconciled with another library's records, it drifts as whoever
 * maintains it changes their mind, and it makes assertions no one can check.
 * This resolves each proposed concept against id.loc.gov instead, so a heading
 * either exists in LCSH with a URI or does not get used. What lands in the
 * catalogue is verifiable by anyone, and $0 carries the URI so a record can say
 * which concept it means rather than which words someone typed.
 *
 * Server-side or script use: it makes a network request per lookup.
 */

/** An authorised LCSH heading, as the Library of Congress states it. */
export type LcshHeading = {
  /** The authorised form. Use this verbatim in 650 $a. */
  label: string;
  /** e.g. http://id.loc.gov/authorities/subjects/sh2024001385; goes in $0. */
  uri: string;
  /** The sh number. */
  token: string;
  /** "Use for" forms, which is what the Authority record's seeAlso holds. */
  variants: string[];
};

type SuggestHit = {
  aLabel?: string;
  suggestLabel?: string;
  uri?: string;
  token?: string;
  more?: {
    rdftypes?: string[];
    collections?: string[];
    variantLabels?: string[];
  };
};

const ENDPOINT = "https://id.loc.gov/authorities/subjects/suggest2";
const TIMEOUT_MS = 15_000;

/**
 * Authorised headings only.
 *
 * The suggest index also returns variant forms and deprecated records. A
 * variant is a pointer to a heading, not a heading: cataloguing under one puts
 * a string in the record that LCSH itself says is not the term. The membership
 * test is the collection, not the label.
 */
function isAuthorised(hit: SuggestHit): boolean {
  const collections = hit.more?.collections ?? [];
  const types = hit.more?.rdftypes ?? [];
  return (
    collections.some((c) => c.endsWith("collection_LCSHAuthorizedHeadings")) &&
    types.includes("Authority") &&
    !types.includes("Deprecated")
  );
}

/**
 * Resolve one concept to its authorised heading, or null.
 *
 * Null is a real answer and must not be smoothed over: a concept LCSH does not
 * carry is a concept this catalogue should not claim. The caller reports it
 * rather than falling back to the raw string.
 */
export async function resolveSubject(term: string): Promise<LcshHeading | null> {
  const q = term.trim();
  if (!q) return null;

  const url = `${ENDPOINT}?q=${encodeURIComponent(q)}&count=8`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "AthenaeumCataloguing/1.0" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { hits?: SuggestHit[] };
    const hits = (body.hits ?? []).filter(isAuthorised);
    if (hits.length === 0) return null;

    // The suggest index is left-anchored, so an exact match on the authorised
    // label is the concept asked for; anything else is a longer heading that
    // merely starts the same way ("Machine learning" vs "Machine learning
    // Machine Learning Repository"). Prefer the exact match, then the shortest,
    // which is the broadest heading rather than an arbitrary subdivision.
    const lower = q.toLowerCase();
    const exact = hits.find((h) => (h.aLabel ?? h.suggestLabel ?? "").toLowerCase() === lower);
    const chosen =
      exact ??
      [...hits].sort(
        (a, b) => (a.aLabel ?? "").length - (b.aLabel ?? "").length,
      )[0];

    const label = chosen.aLabel ?? chosen.suggestLabel ?? "";
    if (!label || !chosen.uri) return null;

    return {
      label,
      uri: chosen.uri,
      token: chosen.token ?? chosen.uri.split("/").pop() ?? "",
      variants: chosen.more?.variantLabels ?? [],
    };
  } catch {
    // A network failure is not evidence the heading is absent. The caller must
    // treat null as "not established" and try again rather than as "no such
    // heading", which is why nothing here writes to the catalogue.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve many concepts, politely: LoC is a public service, not a batch API. */
export async function resolveSubjects(
  terms: string[],
  onResult?: (term: string, hit: LcshHeading | null) => void,
): Promise<Map<string, LcshHeading | null>> {
  const out = new Map<string, LcshHeading | null>();
  for (const term of [...new Set(terms.map((t) => t.trim()).filter(Boolean))]) {
    const hit = await resolveSubject(term);
    out.set(term, hit);
    onResult?.(term, hit);
    await new Promise((r) => setTimeout(r, 120));
  }
  return out;
}
