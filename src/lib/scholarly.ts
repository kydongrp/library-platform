// LiveFetch metadata adapters (SDD: LiveFetch / External Import).
// Searches real scholarly metadata sources and normalises results for
// one-click import into the catalogue.

export type ScholarlyRecord = {
  source: string; // adapter key
  externalId: string; // DOI or source id — used for dedup
  title: string;
  authors: string; // display string
  year: number | null;
  publisher: string | null;
  venue: string | null; // journal / proceedings name
  type: string; // our Resource.type mapping
  url: string; // access link (DOI or OA full text)
  oaUrl: string | null; // open-access full text when known
  abstract: string | null;
};

export const SOURCES = [
  {
    key: "ieee",
    name: "IEEE (via Crossref)",
    description: "IEEE journals, transactions & conference papers — no API key needed.",
  },
  {
    key: "crossref",
    name: "Crossref — all publishers",
    description: "DOI metadata across Springer, Elsevier, ACM, Wiley, IEEE and thousands more.",
  },
  {
    key: "openalex",
    name: "OpenAlex",
    description: "250M+ scholarly works with open-access links where available.",
  },
  {
    key: "xplore",
    name: "IEEE Xplore API",
    description: "IEEE's official metadata API — requires IEEE_API_KEY.",
  },
  {
    key: "manual",
    name: "Manual entry (Janes & others)",
    description: "Add an article by hand for subscription sources with no search API, e.g. Janes, Knovel, IHS.",
  },
] as const;
export type SourceKey = (typeof SOURCES)[number]["key"];

// Providers offered in the manual-entry form (and the catalogue source filter).
// Janes/Knovel/IHS have no public metadata API, so admins add them by hand.
export const MANUAL_PROVIDERS = [
  "IEEE Xplore",
  "Janes",
  "Knovel",
  "IHS Markit",
  "ScienceDirect",
  "JSTOR",
  "ACM Digital Library",
  "ProQuest",
  "SPIE Digital Library",
] as const;

// Sensible default resource type per provider for the manual form.
export const PROVIDER_DEFAULT_TYPE: Record<string, string> = {
  Janes: "JOURNAL",
  Knovel: "EBOOK",
  "IHS Markit": "STANDARD",
};

const TIMEOUT_MS = 10_000;
const IEEE_CROSSREF_MEMBER = "263"; // Crossref member id for IEEE

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Polite pools at Crossref/OpenAlex get better rate limits with contact info.
        "User-Agent": "AthenaeumLiveFetch/1.0 (mailto:library@athenaeum.example)",
      },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Crossref ---------- */

function mapCrossrefType(t: string): string {
  if (t === "proceedings-article") return "CONFERENCE";
  if (t === "book" || t === "monograph" || t === "edited-book" || t === "book-chapter") return "EBOOK";
  if (t === "standard") return "STANDARD";
  return "JOURNAL";
}

type CrossrefItem = {
  DOI?: string;
  title?: string[];
  author?: { given?: string; family?: string }[];
  published?: { "date-parts"?: number[][] };
  "published-print"?: { "date-parts"?: number[][] };
  publisher?: string;
  "container-title"?: string[];
  type?: string;
  URL?: string;
  abstract?: string;
};

function normaliseCrossref(item: CrossrefItem): ScholarlyRecord | null {
  const title = item.title?.[0]?.trim();
  if (!title || !item.DOI) return null;
  const authors =
    item.author
      ?.slice(0, 4)
      .map((a) => [a.given, a.family].filter(Boolean).join(" "))
      .filter(Boolean)
      .join(", ") || "Unknown";
  const more = (item.author?.length ?? 0) > 4 ? ", et al." : "";
  const year =
    item.published?.["date-parts"]?.[0]?.[0] ??
    item["published-print"]?.["date-parts"]?.[0]?.[0] ??
    null;
  return {
    source: "crossref",
    externalId: item.DOI.toLowerCase(),
    title,
    authors: authors + more,
    year,
    publisher: item.publisher ?? null,
    venue: item["container-title"]?.[0] ?? null,
    type: mapCrossrefType(item.type ?? ""),
    url: `https://doi.org/${item.DOI}`,
    oaUrl: null,
    abstract: item.abstract ? stripJats(item.abstract) : null,
  };
}

async function searchCrossref(query: string, ieeeOnly: boolean): Promise<ScholarlyRecord[]> {
  const params = new URLSearchParams({
    "query.bibliographic": query,
    rows: "20",
    select: "DOI,title,author,published,published-print,publisher,container-title,type,URL,abstract",
  });
  if (ieeeOnly) params.set("filter", `member:${IEEE_CROSSREF_MEMBER}`);
  const data = (await getJson(`https://api.crossref.org/works?${params}`)) as {
    message?: { items?: CrossrefItem[] };
  };
  return (data.message?.items ?? [])
    .map(normaliseCrossref)
    .filter((r): r is ScholarlyRecord => r !== null)
    .map((r) => (ieeeOnly ? { ...r, source: "ieee" } : r));
}

/* ---------- OpenAlex ---------- */

type OpenAlexWork = {
  doi?: string | null;
  id?: string;
  display_name?: string;
  publication_year?: number;
  type?: string;
  authorships?: { author?: { display_name?: string } }[];
  primary_location?: {
    source?: { display_name?: string; host_organization_name?: string };
  };
  open_access?: { oa_url?: string | null };
  abstract_inverted_index?: Record<string, number[]> | null;
};

function openAlexAbstract(inv: Record<string, number[]> | null | undefined): string | null {
  if (!inv) return null;
  const words: [number, string][] = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const p of positions) words.push([p, word]);
  }
  const text = words.sort((a, b) => a[0] - b[0]).map(([, w]) => w).join(" ");
  return text.length > 20 ? text.slice(0, 800) : null;
}

async function searchOpenAlex(query: string): Promise<ScholarlyRecord[]> {
  const params = new URLSearchParams({
    search: query,
    "per-page": "20",
    mailto: "library@athenaeum.example",
  });
  const data = (await getJson(`https://api.openalex.org/works?${params}`)) as {
    results?: OpenAlexWork[];
  };
  return (data.results ?? [])
    .map((w): ScholarlyRecord | null => {
      const title = w.display_name?.trim();
      if (!title) return null;
      const doi = w.doi?.replace(/^https?:\/\/doi\.org\//i, "") ?? null;
      const authors =
        w.authorships
          ?.slice(0, 4)
          .map((a) => a.author?.display_name)
          .filter(Boolean)
          .join(", ") || "Unknown";
      const more = (w.authorships?.length ?? 0) > 4 ? ", et al." : "";
      const oaUrl = w.open_access?.oa_url ?? null;
      return {
        source: "openalex",
        externalId: (doi ?? w.id ?? title).toLowerCase(),
        title,
        authors: authors + more,
        year: w.publication_year ?? null,
        publisher: w.primary_location?.source?.host_organization_name ?? null,
        venue: w.primary_location?.source?.display_name ?? null,
        type: w.type === "book" ? "EBOOK" : w.type === "proceedings-article" ? "CONFERENCE" : "JOURNAL",
        url: doi ? `https://doi.org/${doi}` : oaUrl ?? "",
        oaUrl,
        abstract: openAlexAbstract(w.abstract_inverted_index),
      };
    })
    .filter((r): r is ScholarlyRecord => r !== null && r.url !== "");
}

/* ---------- IEEE Xplore (official, key-gated) ---------- */

export function xploreConfigured(): boolean {
  return !!process.env.IEEE_API_KEY;
}

type XploreArticle = {
  doi?: string;
  article_number?: string;
  title?: string;
  authors?: { authors?: { full_name?: string }[] };
  publication_year?: string;
  publication_title?: string;
  content_type?: string;
  html_url?: string;
  abstract?: string;
};

async function searchXplore(query: string): Promise<ScholarlyRecord[]> {
  const key = process.env.IEEE_API_KEY;
  if (!key) throw new Error("IEEE_API_KEY is not configured — use the Crossref-backed IEEE source instead.");
  const params = new URLSearchParams({
    querytext: query,
    max_records: "20",
    apikey: key,
  });
  const data = (await getJson(`https://ieeexploreapi.ieee.org/api/v1/search/articles?${params}`)) as {
    articles?: XploreArticle[];
  };
  return (data.articles ?? [])
    .map((a): ScholarlyRecord | null => {
      if (!a.title) return null;
      const authors =
        a.authors?.authors
          ?.slice(0, 4)
          .map((x) => x.full_name)
          .filter(Boolean)
          .join(", ") || "Unknown";
      return {
        source: "xplore",
        externalId: (a.doi ?? `xplore:${a.article_number}`).toLowerCase(),
        title: a.title,
        authors,
        year: a.publication_year ? parseInt(a.publication_year, 10) : null,
        publisher: "IEEE",
        venue: a.publication_title ?? null,
        type: a.content_type?.toLowerCase().includes("conference") ? "CONFERENCE" : "JOURNAL",
        url: a.html_url ?? (a.doi ? `https://doi.org/${a.doi}` : ""),
        oaUrl: null,
        abstract: a.abstract ?? null,
      };
    })
    .filter((r): r is ScholarlyRecord => r !== null && r.url !== "");
}

/* ---------- Facade ---------- */

function stripJats(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 800);
}

export async function searchScholarly(
  source: SourceKey,
  query: string,
): Promise<ScholarlyRecord[]> {
  switch (source) {
    case "ieee":
      return searchCrossref(query, true);
    case "crossref":
      return searchCrossref(query, false);
    case "openalex":
      return searchOpenAlex(query);
    case "xplore":
      return searchXplore(query);
    default:
      return [];
  }
}

/** Provider label stored on imported resources (drives the source filter). */
export function providerFor(record: ScholarlyRecord): string {
  const pub = (record.publisher ?? "").toLowerCase();
  if (record.source === "xplore" || record.source === "ieee" || pub.includes("ieee"))
    return "IEEE Xplore";
  return record.publisher ?? "Crossref";
}
