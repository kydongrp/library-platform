// AI cataloguing assistant (roadmap #3): draft a catalogue record from a DOI,
// URL, or free-text citation. Server-only. Three paths, cheapest first:
//   1. DOI          → Crossref works API (deterministic, keyless, no AI).
//   2. URL          → guarded page fetch, then Claude extracts the metadata.
//   3. Free text    → Claude drafts from the citation/bibliographic knowledge.
// Nothing is auto-committed: the draft prefills the manual-entry form and
// staff review every field before saving.
import Anthropic from "@anthropic-ai/sdk";
import { CATEGORIES, RESOURCE_TYPES } from "@/lib/constants";
import { isBlockedHost } from "@/lib/net";
import { fetchGuardedPage } from "@/lib/page-fetch";

export type ArticleDraft = {
  title: string;
  authors: string;
  venue: string | null;
  publisher: string | null;
  year: number | null;
  type: string; // one of RESOURCE_TYPES
  category: string; // one of CATEGORIES
  url: string | null;
  abstract: string | null;
  source: "crossref" | "ai" | "ai+page";
  note: string; // provenance one-liner shown to staff
};

export function aiConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Build the client, honouring ANTHROPIC_WORKSPACE_ID when one is set.
 *
 * There are two kinds of Anthropic API key and they do not authenticate the
 * same way. A workspace-scoped key already names the workspace it bills and
 * runs in. An IDENTITY-LINKED key (one created against a person rather than a
 * workspace) does not, so the API rejects every request from one that does not
 * carry an anthropic-workspace-id header telling it which workspace to act in.
 *
 * The deployed key is identity-linked, which is why this screen answered every
 * request with a 400 and no draft was ever produced. Setting
 * ANTHROPIC_WORKSPACE_ID fixes it without swapping the key; swapping in a
 * workspace-scoped key fixes it without setting the variable. Either works, and
 * setting the variable when it is not needed is harmless, so the header is sent
 * whenever the value is present.
 */
export function anthropicClient(): Anthropic {
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
  return new Anthropic(
    workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {},
  );
}

/**
 * Turn an SDK error into something a librarian can act on.
 *
 * The unmodified message is the transport's, not a person's: staff on this
 * screen were shown
 *
 *   400 {"type":"error","error":{"type":"invalid_request_error","message":
 *   "anthropic-workspace-id is required when authenticating with an
 *   identity-linked API key; ..."},"request_id":null}
 *
 * which tells a cataloguer nothing they can do and does not even tell an
 * engineer which environment variable to set. The raw text is still appended
 * for whoever has to fix it, but the sentence in front of it says who fixes it
 * and how.
 */
export function explainAiError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const status = (e as { status?: number } | null)?.status;

  if (/anthropic-workspace-id/i.test(raw))
    return "The AI assistant's API key is identity-linked, so it needs a workspace. Set ANTHROPIC_WORKSPACE_ID in the environment (or replace the key with a workspace-scoped one) and redeploy. DOIs still work without it: paste a DOI and this resolves through Crossref instead.";
  if (status === 401 || /authentication|invalid x-api-key/i.test(raw))
    return "The AI assistant's API key was rejected. Check ANTHROPIC_API_KEY in the environment. DOIs still work without it.";
  if (status === 403 || /permission/i.test(raw))
    return "The AI assistant's API key is not permitted to make this request. Check the key's workspace and permissions. DOIs still work without it.";
  if (status === 429 || /rate.?limit/i.test(raw))
    return "The AI assistant is rate limited right now. Wait a moment and try again, or fill the form in by hand.";
  if (status === 529 || (typeof status === "number" && status >= 500))
    return "The AI assistant is temporarily unavailable. Try again shortly, or fill the form in by hand.";
  if (/abort|timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(raw))
    return "The AI assistant did not respond in time. Try again, or fill the form in by hand.";

  // Our own messages (the refusal and max-tokens cases below) are already
  // written for a librarian and pass through untouched. Only something that
  // carries an HTTP status came from the transport and needs a sentence in
  // front of it.
  if (typeof status !== "number") return raw || "The AI assistant could not draft this record.";
  return `The AI assistant could not draft this record. ${raw}`.trim();
}

const INPUT_MAX = 1_000;
const PAGE_TEXT_MAX = 6_000;
const PAGE_TIMEOUT_MS = 12_000;

/* ---------- Path 1: DOI via Crossref (no AI needed) ---------- */

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;

type CrossrefWork = {
  title?: string[];
  author?: { given?: string; family?: string }[];
  "container-title"?: string[];
  publisher?: string;
  published?: { "date-parts"?: number[][] };
  "published-print"?: { "date-parts"?: number[][] };
  type?: string;
  ISBN?: string[];
  abstract?: string;
  URL?: string;
};

function stripJats(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 800);
}

/**
 * Crossref resolution, exported so the resource intake can reuse it with no
 * API key: registry data, no AI involved.
 */
export async function draftFromDoi(doi: string): Promise<ArticleDraft | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      signal: controller.signal,
      headers: { "User-Agent": "AthenaeumLiveFetch/1.0 (mailto:library@athenaeum.example)" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { message?: CrossrefWork };
    const w = data.message;
    const title = w?.title?.[0]?.trim();
    if (!w || !title) return null;

    const authors =
      w.author
        ?.slice(0, 6)
        .map((a) => [a.given, a.family].filter(Boolean).join(" "))
        .filter(Boolean)
        .join(", ") || "Unknown";
    const year =
      w.published?.["date-parts"]?.[0]?.[0] ?? w["published-print"]?.["date-parts"]?.[0]?.[0] ?? null;
    const t = w.type ?? "";
    const type =
      t === "proceedings-article" ? "CONFERENCE"
      : t === "standard" ? "STANDARD"
      : /book|monograph/.test(t) ? "EBOOK"
      : "JOURNAL";

    return {
      title,
      authors,
      venue: w["container-title"]?.[0] ?? null,
      publisher: w.publisher ?? null,
      year,
      type,
      category: "Technology",
      url: `https://doi.org/${doi}`,
      abstract: w.abstract ? stripJats(w.abstract) : null,
      source: "crossref",
      note: "Metadata resolved from the DOI via Crossref: registry data, no AI involved.",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Path 2: guarded page fetch ---------- */

async function fetchPageText(url: string): Promise<string | null> {
  // fetchGuardedPage rather than bare fetch: it validates the RESOLVED address
  // inside a DNS hook and re-validates every redirect hop. This path used to
  // pair a hostname-only check with redirect: "follow", so a public name whose
  // A record pointed at 169.254.169.254 reached the cloud metadata endpoint.
  // It also gates Content-Type, so a PDF is no longer decoded as utf8 and fed
  // to the model.
  const page = await fetchGuardedPage(url, {
    userAgent: "AthenaeumCatalogueAssistant/1.0",
  });
  if (!page.ok) return null;

  // Keep <meta> tags (citation_* metadata is gold on scholarly pages) as
  // text, drop scripts/styles, then strip the remaining markup.
  const text = page.body
    .replace(/<meta\s+[^>]*name=["']([^"']+)["'][^>]*content=["']([^"']*)["'][^>]*>/gi, " $1: $2 \n")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) =>
      ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " })[m] ?? " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, PAGE_TEXT_MAX) : null;
}

/* ---------- Path 3: Claude drafts the record ---------- */

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "The work's full title" },
    authors: {
      type: "string",
      description: 'Display string of author names separated by "; ", or "Unknown"',
    },
    venue: {
      type: ["string", "null"],
      description: "Journal, proceedings, series, or subtitle; null if not applicable",
    },
    publisher: { type: ["string", "null"] },
    year: { type: ["integer", "null"], description: "Publication year" },
    type: { type: "string", enum: [...RESOURCE_TYPES] },
    category: { type: "string", enum: [...CATEGORIES] },
    url: {
      type: ["string", "null"],
      description: "Canonical access URL (https://…) if confidently known, else null. Never invent one.",
    },
    abstract: { type: ["string", "null"], description: "Short abstract or summary, max ~600 chars" },
    note: {
      type: "string",
      description:
        "One sentence for the librarian: where this metadata came from and how confident you are (e.g. well-known book vs reconstructed from a partial citation).",
    },
  },
  required: ["title", "authors", "venue", "publisher", "year", "type", "category", "url", "abstract", "note"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are a cataloguing assistant for a defence-sector digital library. Staff paste a citation, a title, or a web page's extracted text, and you draft the bibliographic record they will review before saving.

Rules:
- Draft from what is given plus well-established bibliographic knowledge. Never fabricate: if a field is not known with reasonable confidence, use null.
- Never invent URLs or ISBNs. Only return a url you are confident is the canonical location (a doi.org link, a publisher's known landing page, or a URL present in the input).
- "authors" is a display string, names separated by "; ".
- Pick the closest type and category from the allowed values.
- The note field is your provenance statement to the librarian: say what you drew on and flag anything they should double-check.`;

async function draftWithClaude(input: string, pageText: string | null): Promise<ArticleDraft> {
  const client = anthropicClient();

  const userContent = pageText
    ? `Staff input:\n${input}\n\nExtracted text from the page at that URL:\n"""\n${pageText}\n"""`
    : `Staff input:\n${input}`;

  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 4000,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: DRAFT_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  if (response.stop_reason === "refusal")
    throw new Error("The assistant declined to draft this record.");
  if (response.stop_reason === "max_tokens")
    throw new Error("The draft was cut off. Try a shorter input.");

  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("The assistant returned no draft.");
  const parsed = JSON.parse(text) as Omit<ArticleDraft, "source">;

  return {
    ...parsed,
    // Belt-and-braces: never let a non-http(s) URL through.
    url: parsed.url && /^https?:\/\//i.test(parsed.url) ? parsed.url : null,
    type: (RESOURCE_TYPES as readonly string[]).includes(parsed.type) ? parsed.type : "JOURNAL",
    category: (CATEGORIES as readonly string[]).includes(parsed.category)
      ? parsed.category
      : "Technology",
    source: pageText ? "ai+page" : "ai",
    note: parsed.note,
  };
}

/* ---------- Facade ---------- */

export async function draftRecord(rawInput: string): Promise<ArticleDraft> {
  const input = rawInput.trim().slice(0, INPUT_MAX);
  if (!input) throw new Error("Paste a DOI, URL, or citation to draft from.");

  // DOI → Crossref, deterministic and free. Works even without an API key.
  const doi = input.match(DOI_RE)?.[1]?.replace(/[).,;]+$/, "");
  if (doi) {
    const fromDoi = await draftFromDoi(doi);
    if (fromDoi) return fromDoi;
    // fall through to AI if Crossref doesn't know the DOI
  }

  if (!aiConfigured())
    throw new Error(
      doi
        ? "That DOI wasn't found in Crossref, and the AI assistant is not configured (set ANTHROPIC_API_KEY)."
        : "The AI assistant is not configured: set ANTHROPIC_API_KEY in the environment. (DOIs still work: they resolve via Crossref.)",
    );

  // URL → fetch the page (guarded) so the model extracts rather than recalls.
  const urlMatch = input.match(/https?:\/\/[^\s"'<>]+/i)?.[0] ?? null;
  const pageText = urlMatch ? await fetchPageText(urlMatch) : null;
  let draft: ArticleDraft;
  try {
    draft = await draftWithClaude(input, pageText);
  } catch (e) {
    throw new Error(explainAiError(e));
  }

  // If the input itself contained the URL, prefer it over a model guess.
  if (urlMatch && !isBlockedHost(urlMatch)) draft.url = draft.url ?? urlMatch;
  return draft;
}
