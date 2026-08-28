/**
 * Turn a URL into a catalogue record, cheapest and most reliable first.
 *
 * The point of this module is that it needs no API key. The existing AI
 * assistant (src/lib/ai-draft.ts) is excellent when a human is reviewing every
 * field, but an intake that a member of staff fires from a phone should not
 * depend on a paid model being configured, and most of the pages worth
 * cataloguing already state their own metadata properly.
 *
 * The ladder:
 *   1. A bare DOI                 -> Crossref. Registry data, no fetch.
 *   2. Highwire citation_* tags   -> what publishers put there for Google
 *                                    Scholar. Authoritative on IEEE, ACM,
 *                                    Springer, arXiv, PubMed and friends.
 *   3. Dublin Core DC.* tags      -> repositories and library systems.
 *   4. JSON-LD schema.org         -> news sites and modern CMSs.
 *   5. Open Graph / twitter:      -> almost everything else.
 *   6. <title>                    -> always something.
 *   7. The hostname               -> never nothing.
 *
 * If any rung yields a DOI, rung 1 runs again to upgrade the record, because
 * registry data beats a page's own tags.
 *
 * parseHtmlMetadata is pure and separately tested (scripts/test-metadata.ts):
 * every rung above is a decision about precedence, and precedence is exactly
 * the kind of thing that quietly regresses.
 */
import { draftFromDoi, type ArticleDraft } from "@/lib/ai-draft";
import { fetchGuardedPage, type FetchFailure } from "@/lib/page-fetch";
import { RESOURCE_TYPES } from "@/lib/constants";

const TITLE_MAX = 300;
const AUTHORS_MAX = 300;
const ABSTRACT_MAX = 800;
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>&]+)/i;

/** What the page itself claims about a work. All fields optional by nature. */
export type PageMetadata = {
  title: string | null;
  authors: string | null;
  year: number | null;
  venue: string | null;
  publisher: string | null;
  doi: string | null;
  abstract: string | null;
  type: string | null;
  /** Which rung produced the title, for the provenance note shown to staff. */
  source: "citation" | "dublin-core" | "json-ld" | "open-graph" | "title" | "none";
};

const EMPTY: PageMetadata = {
  title: null,
  authors: null,
  year: null,
  venue: null,
  publisher: null,
  doi: null,
  abstract: null,
  type: null,
  source: "none",
};

/* ---------- HTML helpers ---------- */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
  "&mdash;": "-",
  "&ndash;": "-",
  "&hellip;": "...",
  "&rsquo;": "'",
  "&lsquo;": "'",
  "&ldquo;": '"',
  "&rdquo;": '"',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp|mdash|ndash|hellip|rsquo|lsquo|ldquo|rdquo);/g,
      (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d{1,7});/g, (_, d) => {
      const n = Number(d);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => {
      const n = parseInt(h, 16);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    });
}

function clean(v: string | null | undefined, max: number): string | null {
  if (!v) return null;
  const out = decodeEntities(v).replace(/\s+/g, " ").trim();
  return out ? out.slice(0, max) : null;
}

/**
 * Collect every <meta> tag as name/property -> content.
 *
 * Attribute order varies (content before name is common), and a page may
 * repeat a tag, which is how multiple authors are expressed. Both are handled:
 * values accumulate in order of appearance.
 */
export function metaTags(html: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const key =
      tag.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1] ??
      tag.match(/\bproperty\s*=\s*["']([^"']+)["']/i)?.[1] ??
      tag.match(/\bitemprop\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!key) continue;
    const content =
      tag.match(/\bcontent\s*=\s*"([^"]*)"/i)?.[1] ??
      tag.match(/\bcontent\s*=\s*'([^']*)'/i)?.[1];
    if (content === undefined) continue;
    const k = key.trim().toLowerCase();
    const list = out.get(k);
    if (list) list.push(content);
    else out.set(k, [content]);
  }
  return out;
}

function first(tags: Map<string, string[]>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = tags.get(k)?.[0];
    if (v && v.trim()) return v;
  }
  return null;
}

function all(tags: Map<string, string[]>, ...keys: string[]): string[] {
  for (const k of keys) {
    const v = tags.get(k);
    if (v?.length) return v;
  }
  return [];
}

/** Pull a 4-digit year out of a date string of unknown format. */
export function yearOf(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  if (!m) return null;
  const y = Number(m[1]);
  // A year far in the future is a parse artefact, not a publication date.
  return y >= 1500 && y <= 2100 ? y : null;
}

/**
 * Map a page's own type words onto RESOURCE_TYPES.
 *
 * Deliberately conservative: an unrecognised word yields null so the caller's
 * own default applies, rather than mislabelling a record.
 */
export function resourceTypeFrom(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (/proceeding|conference|inproceedings/.test(s)) return "CONFERENCE";
  if (/standard|specification/.test(s)) return "STANDARD";
  // News and magazine are tested BEFORE journal/article: "NewsArticle" and
  // "MagazineArticle" both contain "article", so the generic rule would
  // swallow them and label a news story a journal.
  if (/newspaper|news/.test(s)) return "NEWSPAPER";
  if (/magazine/.test(s)) return "MAGAZINE";
  if (/journal|article|periodical/.test(s)) return "JOURNAL";
  if (/thesis|dissertation|report|book|monograph|ebook/.test(s)) return "EBOOK";
  return null;
}

/** JSON-LD blocks, parsed defensively: a malformed block must not throw. */
function jsonLdNodes(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const blocks =
    html.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    const body = block.replace(/^[\s\S]*?>/, "").replace(/<\/script>$/i, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    // A block may be one node, an array, or an @graph wrapper.
    const queue: unknown[] = [parsed];
    while (queue.length) {
      const n = queue.shift();
      if (Array.isArray(n)) {
        queue.push(...n);
        continue;
      }
      if (n && typeof n === "object") {
        const obj = n as Record<string, unknown>;
        out.push(obj);
        if (Array.isArray(obj["@graph"])) queue.push(...(obj["@graph"] as unknown[]));
      }
    }
  }
  return out;
}

/** JSON-LD @type values that describe the site or a person, not the work. */
const NON_WORK_TYPE_RE =
  /website|organization|person|breadcrumb|searchaction|imageobject|sitenavigation|listitem|collectionpage|webpageelement/i;

/** @type values that positively identify the work itself. */
const WORK_TYPE_RE =
  /article|paper|book|report|thesis|dissertation|chapter|dataset|creativework|publication|periodical|blogposting|scholarly/i;

/**
 * JSON-LD nodes, most likely to be the work first.
 *
 * Three bands: the work, then anything unclassified, then site furniture. The
 * order is what stops an Organization's name being read as the title.
 */
function rankedJsonLdNodes(html: string): Record<string, unknown>[] {
  const rank = (n: Record<string, unknown>): number => {
    const t = jsonLdString(n["@type"]) ?? "";
    if (WORK_TYPE_RE.test(t) && !NON_WORK_TYPE_RE.test(t)) return 0;
    if (NON_WORK_TYPE_RE.test(t)) return 2;
    return 1;
  };
  // A stable sort keeps document order within each band, so the first article
  // on the page still wins over a later one.
  return jsonLdNodes(html)
    .map((n, i) => ({ n, i, r: rank(n) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.n);
}

function jsonLdString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const parts = v.map(jsonLdString).filter(Boolean) as string[];
    return parts.length ? parts.join(", ") : null;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return jsonLdString(o.name) ?? jsonLdString(o["@value"]);
  }
  return null;
}

/**
 * Read a page's own claims about itself. Pure: HTML in, metadata out.
 */
export function parseHtmlMetadata(html: string): PageMetadata {
  const tags = metaTags(html);
  const m: PageMetadata = { ...EMPTY };

  // Rung 2: Highwire citation_* tags. Publishers maintain these for Google
  // Scholar, so on a scholarly page they are the most reliable thing present.
  const citTitle = first(tags, "citation_title");
  const citAuthors = all(tags, "citation_author", "citation_authors");
  if (citTitle) {
    m.title = clean(citTitle, TITLE_MAX);
    m.source = "citation";
  }
  if (citAuthors.length) {
    m.authors = clean(citAuthors.join("; "), AUTHORS_MAX);
  }
  m.year =
    yearOf(first(tags, "citation_publication_date", "citation_date", "citation_year", "citation_online_date"));
  m.venue = clean(
    first(tags, "citation_journal_title", "citation_conference_title", "citation_inbook_title", "citation_series_title"),
    TITLE_MAX,
  );
  m.publisher = clean(first(tags, "citation_publisher", "citation_technical_report_institution"), TITLE_MAX);
  m.doi = first(tags, "citation_doi")?.match(DOI_RE)?.[1] ?? null;
  m.abstract = clean(first(tags, "citation_abstract", "description"), ABSTRACT_MAX);

  // Rung 3: Dublin Core, used by institutional repositories.
  if (!m.title) {
    const dc = first(tags, "dc.title", "dcterms.title");
    if (dc) {
      m.title = clean(dc, TITLE_MAX);
      m.source = "dublin-core";
    }
  }
  if (!m.authors) {
    const dcAuthors = all(tags, "dc.creator", "dcterms.creator", "dc.contributor");
    if (dcAuthors.length) m.authors = clean(dcAuthors.join("; "), AUTHORS_MAX);
  }
  m.year ??= yearOf(first(tags, "dc.date", "dcterms.issued", "dc.date.issued"));
  m.publisher ??= clean(first(tags, "dc.publisher", "dcterms.publisher"), TITLE_MAX);
  m.type ??= resourceTypeFrom(first(tags, "dc.type", "dcterms.type"));
  if (!m.doi) {
    const dcId = first(tags, "dc.identifier", "dcterms.identifier");
    m.doi = dcId?.match(DOI_RE)?.[1] ?? null;
  }

  // Rung 4: JSON-LD, work-like nodes first.
  //
  // Ordering matters. A page routinely ships an Organization or WebSite node
  // alongside the article, and those carry a `name` ("IEEE Xplore") that would
  // otherwise beat the article's `headline`. Nodes that describe the site
  // rather than the work never supply a title or authors, though their name is
  // still a fair guess at the publisher.
  for (const node of rankedJsonLdNodes(html)) {
    const t = jsonLdString(node["@type"]);
    const describesWork = !NON_WORK_TYPE_RE.test(t ?? "");
    if (!m.title && describesWork) {
      const name = jsonLdString(node.headline) ?? jsonLdString(node.name);
      if (name) {
        m.title = clean(name, TITLE_MAX);
        m.source = "json-ld";
      }
    }
    if (describesWork) {
      m.authors ??= clean(jsonLdString(node.author) ?? jsonLdString(node.creator), AUTHORS_MAX);
    }
    m.year ??= yearOf(jsonLdString(node.datePublished) ?? jsonLdString(node.dateCreated));
    m.publisher ??= clean(jsonLdString(node.publisher), TITLE_MAX);
    m.abstract ??= clean(jsonLdString(node.description) ?? jsonLdString(node.abstract), ABSTRACT_MAX);
    m.venue ??= clean(jsonLdString(node.isPartOf), TITLE_MAX);
    m.type ??= resourceTypeFrom(t);
    if (!m.doi) {
      const ident = jsonLdString(node.identifier) ?? jsonLdString(node.doi) ?? jsonLdString(node.sameAs);
      m.doi = ident?.match(DOI_RE)?.[1] ?? null;
    }
  }

  // Rung 5: Open Graph and twitter cards.
  if (!m.title) {
    const og = first(tags, "og:title", "twitter:title");
    if (og) {
      m.title = clean(og, TITLE_MAX);
      m.source = "open-graph";
    }
  }
  m.publisher ??= clean(first(tags, "og:site_name", "application-name"), TITLE_MAX);
  m.abstract ??= clean(first(tags, "og:description", "twitter:description", "description"), ABSTRACT_MAX);
  m.year ??= yearOf(first(tags, "article:published_time", "article:modified_time", "date"));
  m.authors ??= clean(first(tags, "author", "article:author", "twitter:creator"), AUTHORS_MAX);
  m.type ??= resourceTypeFrom(first(tags, "og:type"));

  // Rung 6: the document title.
  if (!m.title) {
    const raw = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    const t = clean(raw, TITLE_MAX);
    if (t) {
      m.title = t;
      m.source = "title";
    }
  }

  // A DOI printed in the body is still better than nothing.
  if (!m.doi) m.doi = html.match(/\bdoi\.org\/(10\.\d{4,9}\/[^\s"'<>&]+)/i)?.[1] ?? null;

  return m;
}

/**
 * A last-resort title from the URL itself, so a record always has something a
 * human can recognise and correct.
 */
export function titleFromUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const slug = u.pathname.split("/").filter(Boolean).pop() ?? "";
    const words = decodeURIComponent(slug)
      .replace(/\.(html?|php|aspx?|pdf|jsp)$/i, "")
      .replace(/[-_+]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (words.length >= 3 && /[a-z]/i.test(words)) {
      return words.slice(0, TITLE_MAX).replace(/^./, (c) => c.toUpperCase());
    }
    return u.hostname.replace(/^www\./, "");
  } catch {
    return raw.slice(0, TITLE_MAX);
  }
}

export type ResolvedMetadata = {
  draft: ArticleDraft;
  /** Where the metadata came from, in words, for the audit trail and the UI. */
  provenance: string;
  /** Set when the page could not be read; the record is still usable. */
  fetchFailure: FetchFailure | null;
};

function draftFrom(page: PageMetadata, url: string, fallbackTitle: string): ArticleDraft {
  const type = page.type && (RESOURCE_TYPES as readonly string[]).includes(page.type) ? page.type : "EBOOK";
  return {
    title: page.title ?? fallbackTitle,
    authors: page.authors ?? "Unknown",
    venue: page.venue,
    publisher: page.publisher,
    year: page.year,
    type,
    category: "Technology",
    url,
    abstract: page.abstract,
    source: "crossref",
    note: "",
  };
}

const SOURCE_WORDS: Record<PageMetadata["source"], string> = {
  citation: "the publisher's citation_* metadata",
  "dublin-core": "the page's Dublin Core metadata",
  "json-ld": "the page's schema.org JSON-LD",
  "open-graph": "the page's Open Graph tags",
  title: "the page title",
  none: "the web address",
};

/**
 * Resolve a submitted URL or DOI into a draft record.
 *
 * Never throws and never returns nothing: a page that cannot be fetched still
 * produces a record titled from its URL, which a librarian can correct in the
 * catalogue. Refusing outright would lose the submission.
 */
export async function resolveMetadata(
  input: { kind: "url"; value: string } | { kind: "doi"; value: string },
): Promise<ResolvedMetadata> {
  // Rung 1: a bare DOI needs no fetch at all.
  if (input.kind === "doi") {
    const byDoi = await draftFromDoi(input.value);
    if (byDoi) {
      return {
        draft: byDoi,
        provenance: `Resolved from DOI ${input.value} via Crossref.`,
        fetchFailure: null,
      };
    }
    const url = `https://doi.org/${input.value}`;
    return {
      draft: draftFrom(EMPTY, url, `DOI ${input.value}`),
      provenance: `Crossref had no record for DOI ${input.value}; saved the resolver link.`,
      fetchFailure: null,
    };
  }

  const page = await fetchGuardedPage(input.value);
  if (!page.ok) {
    return {
      draft: draftFrom(EMPTY, input.value, titleFromUrl(input.value)),
      provenance: `The page could not be read (${page.reason}), so the title comes from the web address. Please check it.`,
      fetchFailure: page.reason,
    };
  }

  const meta = parseHtmlMetadata(page.body);

  // A DOI found anywhere on the page beats the page's own tags: registry data
  // is maintained, page markup rots.
  if (meta.doi) {
    const byDoi = await draftFromDoi(meta.doi);
    if (byDoi) {
      return {
        // Keep the link the sender actually shared: it is the one their
        // institution has access through, and proxy-link rewrites it at serve
        // time. The DOI is recorded in the provenance note.
        draft: { ...byDoi, url: page.finalUrl },
        provenance: `Found DOI ${meta.doi} on the page and resolved it via Crossref.`,
        fetchFailure: null,
      };
    }
  }

  const draft = draftFrom(meta, page.finalUrl, titleFromUrl(page.finalUrl));
  const redirectNote = page.hops > 0 ? ` after ${page.hops} redirect${page.hops > 1 ? "s" : ""}` : "";
  return {
    draft,
    provenance: `Read from ${SOURCE_WORDS[meta.source]}${redirectNote}.`,
    fetchFailure: null,
  };
}
