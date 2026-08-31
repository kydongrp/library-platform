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
  /**
   * Whether label is the term that was asked for.
   *
   * False means "this is the nearest authorised heading the index offered",
   * which is a lead for a human and NOT a heading to catalogue under. It exists
   * because the alternative, returning null, throws away the only clue about
   * what went wrong. Callers that write to a record must require exact.
   */
  exact: boolean;
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

const ATTEMPTS = 3;

/** One call to the suggest index, authorised hits only. Null on any failure. */
async function suggestOnce(q: string, searchtype?: string): Promise<SuggestHit[] | null> {
  const url =
    `${ENDPOINT}?q=${encodeURIComponent(q)}&count=25` +
    (searchtype ? `&searchtype=${searchtype}` : "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "AthenaeumCataloguing/1.0" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { hits?: SuggestHit[] };
    return (body.hits ?? []).filter(isAuthorised);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The same call, retried, because a null here is indistinguishable downstream
 * from "LCSH has no such heading" and the two must not be confused.
 *
 * This is not a hypothetical. Resolving 40-odd headings in a loop on 31 August
 * 2026, one request to id.loc.gov failed transiently and "Sea-power--China" was
 * reported as having no authorised heading. It has one, sh2010112358, and three
 * consecutive retries returned it immediately. Without retries a caller drops a
 * perfectly good heading from a record and prints a sentence about LCSH that is
 * not true.
 */
async function suggest(q: string, searchtype?: string): Promise<SuggestHit[] | null> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const hits = await suggestOnce(q, searchtype);
    if (hits !== null) return hits;
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  return null;
}

function labelOf(h: SuggestHit): string {
  return h.aLabel ?? h.suggestLabel ?? "";
}

/**
 * Resolve one concept to its authorised heading, or null.
 *
 * Null is a real answer and must not be smoothed over: a concept LCSH does not
 * carry is a concept this catalogue should not claim. The caller reports it
 * rather than falling back to the raw string.
 *
 * TWO LOOKUPS, and the second one is not optional.
 *
 * The suggest index defaults to a LEFT-ANCHORED search, and that search does
 * not return every authorised heading whose label it matches. Measured against
 * "Cryptography" on 31 August 2026: the default search returns ten hits, and
 * the only one carrying that exact label is sh99005451, which is a topical
 * SUBDIVISION record and so is correctly filtered out here. The authorised
 * heading, sh85034453 (collection_LCSHAuthorizedHeadings), is absent from that
 * response entirely. Adding searchtype=keyword returns it as the first hit.
 *
 * That mattered because of what this function used to do next. Finding no exact
 * match, it returned the SHORTEST authorised hit, "on the grounds that the
 * shortest is the broadest heading". For "Cryptography" the shortest hit is
 * "Cryptography in art", which is not broader, not related, and would have
 * filed a post-quantum cryptography standard under art history. So the fallback
 * is gone: a non-exact result is now labelled exact:false and is a diagnostic,
 * never an answer.
 */
export async function resolveSubject(term: string): Promise<LcshHeading | null> {
  const q = term.trim();
  if (!q) return null;
  const lower = q.toLowerCase();
  const isExact = (h: SuggestHit) => labelOf(h).toLowerCase() === lower;

  const anchored = await suggest(q);
  // A null here is a network or service failure, not an absence, so it must not
  // be reported as "no such heading". Distinguishing the two is the caller's
  // job and all it can do is retry, which is why nothing here writes anything.
  if (anchored === null) return null;

  let chosen = anchored.find(isExact);
  if (!chosen) {
    const keyword = await suggest(q, "keyword");
    chosen = (keyword ?? []).find(isExact);
  }

  const exact = Boolean(chosen);
  // Nearest offer, purely so the caller can say what it saw. Shortest is used
  // only to make that message stable, and carries no claim of being broader.
  if (!chosen) {
    chosen = [...anchored].sort((a, b) => labelOf(a).length - labelOf(b).length)[0];
  }
  if (!chosen) return null;

  const label = labelOf(chosen);
  if (!label || !chosen.uri) return null;

  return {
    label,
    uri: chosen.uri,
    token: chosen.token ?? chosen.uri.split("/").pop() ?? "",
    variants: chosen.more?.variantLabels ?? [],
    exact,
  };
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
