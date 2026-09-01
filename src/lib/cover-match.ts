/**
 * Which common cover image a new bib record should get.
 *
 * Most imported records have no cover art, so the catalogue renders a coloured
 * placeholder. Staff can instead upload a pool of "common" covers (a plain
 * house design per collection, per publisher, or a generic one) and have one
 * assigned automatically as each record is created.
 *
 * The selection rule, in order:
 *
 *   1. collection   an image whose file name matches the record's category
 *   2. publisher    an image whose file name matches the record's publisher
 *   3. general      a generic image, chosen at random
 *
 * The match key is the IMAGE FILE NAME, which makes the pool self-describing:
 * a file called `defence-01.png` covers the Defence collection, `ieee-xplore-3.jpg`
 * covers that publisher, `general-2.png` is a fallback. Staff manage the rule by
 * naming files, with no second mapping screen to keep in step.
 *
 * WHY THE FALLBACK STOPS AT "general" rather than picking any image at all:
 * a random pick from the whole pool would put a Defence cover on a medical
 * report. When no general image exists, this returns null and the record keeps
 * its coloured placeholder, which is honest rather than wrong. The admin screen
 * says so when the pool has no general image.
 *
 * Pure: no database, no network, no clock. Client-safe, so the admin screen can
 * show staff exactly what a file name will match before they upload it.
 */

/** File-name tokens that mean "use me for anything". */
export const GENERAL_TOKENS = ["general", "default", "common", "generic", "placeholder"];

/** Image types accepted for a cover. */
export const COVER_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type CoverMimeType = (typeof COVER_MIME_TYPES)[number];

export const COVER_EXTENSIONS: Record<CoverMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * Fold a name to its comparable form: lower case, punctuation to single spaces.
 *
 * So the category "Defence" matches `Defence-01.png`, and the publisher
 * "IEEE Xplore" matches `ieee_xplore_2.jpg`. Without this, matching would be an
 * exact-string game staff could not win.
 */
export function normaliseKey(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The match token carried by a file name.
 *
 * The extension goes, then any trailing sequence number, so a set of files
 * named for the same subject all carry the same token:
 *
 *   defence-01.png        -> "defence"
 *   defence 2.png         -> "defence"
 *   ieee_xplore_3.jpg     -> "ieee xplore"
 *   general.webp          -> "general"
 *   Naval War College.png -> "naval war college"
 *
 * Only ONE trailing number group is stripped. A name that is only a number
 * (`01.png`) keeps nothing and becomes a general image, which is the sensible
 * reading of a file named after nothing.
 */
export function tokenFromFileName(fileName: string): string {
  const withoutDir = String(fileName ?? "").split(/[\\/]/).pop() ?? "";
  const withoutExt = withoutDir.replace(/\.[a-z0-9]{1,5}$/i, "");
  const withoutSeq = withoutExt.replace(/[\s._-]*\d+$/, "");
  return normaliseKey(withoutSeq);
}

/**
 * The three tiers assignment can match on. Ordered, and exhaustive: a chosen
 * cover was matched on exactly one of these.
 */
export type CoverMatchTier = "collection" | "publisher" | "general";

/**
 * How a file name will be used, for display on the admin screen.
 *
 * "unused" is the fourth state and the reason this type is not just
 * CoverMatchTier: an image whose token is neither a reserved general word nor
 * the name of a live collection or publisher can never be assigned by anything.
 * It has to be shown as such. The first version of this reported that case as
 * "general", which read as "will be used as a fallback" while the assignment
 * code would never pick it: the screen and the behaviour disagreed, and the
 * screen was the one telling staff something untrue.
 */
export type CoverScope = CoverMatchTier | "unused";

/**
 * What a token will match, given the collections and publishers in use.
 *
 * A token that matches neither a live collection nor a live publisher is
 * reported as general: it will only ever be picked by the random fallback, and
 * the screen can say so instead of implying it targets something.
 */
export function describeToken(
  token: string,
  known: { collections: string[]; publishers: string[] },
): { scope: CoverScope; matches: string | null } {
  // Only an empty token or a reserved word is general, and this must stay in
  // step with the general tier in chooseCover below. If the two ever diverge,
  // this function lies to the person deciding what to name a file.
  if (!token || GENERAL_TOKENS.includes(token)) return { scope: "general", matches: null };
  const collection = known.collections.find((c) => normaliseKey(c) === token);
  if (collection) return { scope: "collection", matches: collection };
  const publisher = known.publishers.find((p) => normaliseKey(p) === token);
  if (publisher) return { scope: "publisher", matches: publisher };
  return { scope: "unused", matches: null };
}

export type CoverCandidate = {
  id: string;
  /** Pre-computed via tokenFromFileName, so matching never re-parses. */
  token: string;
};

export type CoverTarget = {
  /** The record's category, which this catalogue calls its collection. */
  collection?: string | null;
  publisher?: string | null;
};

export type CoverChoice = {
  id: string;
  matchedOn: CoverMatchTier;
};

/**
 * Pick an index in [0, n). Injected so tests are deterministic and the
 * production caller can pass a real random source.
 */
export type IndexPicker = (n: number) => number;

export const randomIndex: IndexPicker = (n) => Math.floor(Math.random() * n);

/** Guard the picker: an out-of-range or non-integer result must not throw. */
function safePick(pick: IndexPicker, n: number): number {
  if (n <= 0) return -1;
  const raw = pick(n);
  if (!Number.isFinite(raw)) return 0;
  const i = Math.floor(raw);
  if (i < 0) return 0;
  if (i >= n) return n - 1;
  return i;
}

/**
 * Choose one cover for one record, or null to keep the coloured placeholder.
 *
 * Candidates are filtered, not sorted, at each step: within a tier the choice
 * is random, so a collection with four house covers gets an even spread rather
 * than the same file every time.
 */
export function chooseCover(
  target: CoverTarget,
  candidates: CoverCandidate[],
  pick: IndexPicker = randomIndex,
): CoverChoice | null {
  if (candidates.length === 0) return null;

  const collection = normaliseKey(target.collection);
  const publisher = normaliseKey(target.publisher);

  const tiers: { scope: CoverMatchTier; pool: CoverCandidate[] }[] = [
    {
      scope: "collection",
      // An empty key must not match a general image here, or an uncategorised
      // record would be reported as a collection match. Hence the guard.
      pool: collection ? candidates.filter((c) => c.token === collection) : [],
    },
    {
      scope: "publisher",
      pool: publisher ? candidates.filter((c) => c.token === publisher) : [],
    },
    {
      scope: "general",
      pool: candidates.filter((c) => !c.token || GENERAL_TOKENS.includes(c.token)),
    },
  ];

  for (const tier of tiers) {
    const i = safePick(pick, tier.pool.length);
    if (i >= 0) return { id: tier.pool[i].id, matchedOn: tier.scope };
  }
  return null;
}

/**
 * Read an image's type from its own bytes.
 *
 * The browser-declared content type is attacker-controlled and, more mundanely,
 * often just wrong. This reads the magic bytes instead, which is the same
 * lesson the access-link checker learned: trust what came back, not what it
 * said about itself.
 *
 * SVG is deliberately absent. It is XML that can carry script, and it would be
 * served from this origin, so accepting it would turn a cover upload into a
 * stored cross-site-scripting vector.
 */
export function sniffImageType(bytes: Uint8Array): CoverMimeType | null {
  const at = (i: number) => bytes[i];
  if (bytes.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 &&
    at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a
  ) return "image/png";

  // JPEG: FF D8 FF
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";

  // GIF: "GIF87a" or "GIF89a"
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";

  // WebP: "RIFF" .... "WEBP"
  if (
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) return "image/webp";

  return null;
}
