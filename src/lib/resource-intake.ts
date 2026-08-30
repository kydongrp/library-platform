/**
 * External resource intake: a URL in, a catalogue record out.
 *
 * Somebody finds something worth having and has the link. This turns that into
 * a catalogued, link-out resource without making them fill in a cataloguing
 * form, and hands back the URL to reach it.
 *
 * The pieces were built for a WhatsApp bot that was then abandoned: WhatsApp's
 * Business Messaging Policy prohibits military and national-security use and
 * requires government entities to go through a Solution Provider, none of which
 * this client can satisfy on the direct Cloud API. Nothing about the work was
 * WhatsApp-specific except the transport, so the transport became an
 * authenticated page instead, which is a better fit anyway: no third party in
 * the path, no business verification, and the submitter is already identified.
 *
 * Server-only. The decisions that can be made without a database live in
 * submission-core.ts and url-metadata.ts and are tested separately.
 */
import { prisma } from "@/lib/db";
import { parseSubmission, canonicaliseUrl, isUsableHttpUrl } from "@/lib/submission-core";
import { resolveMetadata } from "@/lib/url-metadata";
import { coverColorFor } from "@/lib/ingest";
import { proxiedUrl } from "@/lib/proxy-link";
import { portalResourceUrl } from "@/lib/portal-links";
import { UNCATEGORISED, RESOURCE_TYPES, defaultDesignationFor } from "@/lib/constants";
import { admitUrl, type FetchFailure } from "@/lib/page-fetch";

export const INTAKE_INPUT_MAX = 2_000;

export type IntakeLinks = {
  /** The admin record for the new or existing title. */
  catalogue: string;
  /** What a reader clicks, proxied when the provider warrants it. */
  access: string | null;
  /** The learner portal, when PORTAL_RESOURCE_URL is configured. */
  portal: string | null;
};

export type IntakeResult =
  | {
      status: "created" | "duplicate";
      id: string;
      title: string;
      authors: string;
      year: number | null;
      publisher: string | null;
      type: string;
      /** Where the metadata came from, in words, for the confirmation panel. */
      provenance: string;
      /** Set when the page could not be read; the record is still usable. */
      fetchFailure: FetchFailure | null;
      links: IntakeLinks;
    }
  | { status: "rejected"; reason: string };

function linksFor(id: string, digitalUrl: string | null, provider: string | null): IntakeLinks {
  return {
    catalogue: `/admin/catalogue/${id}`,
    access: proxiedUrl(digitalUrl, provider),
    portal: portalResourceUrl(id),
  };
}

/**
 * Take one submission and make a record of it.
 *
 * Never throws for an input problem: an unusable submission comes back as
 * `rejected` with something a person can act on. A genuine database failure
 * still throws, because that is not the submitter's problem to read about.
 */
export async function intakeResource(args: {
  input: string;
  /** Optional subscription source, for proxying and cost-per-use grouping. */
  provider?: string | null;
  /** Who is adding it, recorded on the record. */
  adminName: string;
}): Promise<IntakeResult> {
  const raw = args.input.slice(0, INTAKE_INPUT_MAX);
  const submission = parseSubmission(raw);

  if (submission.kind === "empty") {
    return {
      status: "rejected",
      reason:
        "Paste a link (https://…) or a DOI. Other schemes and bare words are not accepted, because the server has to fetch what you paste.",
    };
  }

  const submittedUrl =
    submission.kind === "url" ? submission.value : `https://doi.org/${submission.value}`;

  // Refuse an illegitimate target before fetching, and before creating
  // anything. A link the fetcher will not follow is not a resource that failed
  // to load, it is not a resource: cataloguing it would put the cloud metadata
  // endpoint, or a loopback address, in the library with a title derived from
  // its path, and hand that link to a reader.
  if (submission.kind === "url") {
    const admitted = admitUrl(submittedUrl);
    if (!admitted.ok) {
      return { status: "rejected", reason: REFUSAL_TEXT[admitted.reason] };
    }
  }

  // The canonical form decides what counts as already in the library, so the
  // duplicate check has to run on it rather than on what was typed: the same
  // article shared from two apps differs only by tracking parameters.
  const earlyDuplicate = await findExisting(submittedUrl);
  if (earlyDuplicate) {
    return {
      status: "duplicate",
      id: earlyDuplicate.id,
      title: earlyDuplicate.title,
      authors: earlyDuplicate.author,
      year: earlyDuplicate.publishedYear,
      publisher: earlyDuplicate.publisher,
      type: earlyDuplicate.type,
      provenance: "Already in the library; nothing was added.",
      fetchFailure: null,
      links: linksFor(earlyDuplicate.id, earlyDuplicate.digitalUrl, earlyDuplicate.provider),
    };
  }

  const resolved = await resolveMetadata(submission);

  // The same refusal after the fetch: a perfectly public URL may redirect into
  // private space, and fetchGuardedPage reports that as "blocked" only once it
  // has followed the hop. Saving the record anyway would defeat the check.
  if (resolved.fetchFailure && resolved.fetchFailure in REFUSAL_TEXT) {
    return {
      status: "rejected",
      reason: REFUSAL_TEXT[resolved.fetchFailure as keyof typeof REFUSAL_TEXT],
    };
  }

  const draft = resolved.draft;

  // resolveMetadata follows redirects, so the URL it settles on may differ from
  // the one pasted (a DOI resolver, a shortener, a login bounce). Store where
  // it actually landed, and check for a duplicate again: two different pasted
  // links can resolve to the same article.
  const finalUrl = draft.url && isUsableHttpUrl(draft.url) ? draft.url : submittedUrl;
  const canonical = canonicaliseUrl(finalUrl);

  if (canonical !== canonicaliseUrl(submittedUrl)) {
    const lateDuplicate = await findExisting(finalUrl);
    if (lateDuplicate) {
      return {
        status: "duplicate",
        id: lateDuplicate.id,
        title: lateDuplicate.title,
        authors: lateDuplicate.author,
        year: lateDuplicate.publishedYear,
        publisher: lateDuplicate.publisher,
        type: lateDuplicate.type,
        provenance: `That link resolves to something already in the library. ${resolved.provenance}`,
        fetchFailure: resolved.fetchFailure,
        links: linksFor(lateDuplicate.id, lateDuplicate.digitalUrl, lateDuplicate.provider),
      };
    }
  }

  const type = (RESOURCE_TYPES as readonly string[]).includes(draft.type) ? draft.type : "EBOOK";
  const provider = args.provider?.trim() || null;

  try {
    const created = await prisma.resource.create({
      data: {
        title: draft.title.slice(0, 500),
        subtitle: draft.venue?.slice(0, 300) ?? null,
        author: (draft.authors || "Unknown").slice(0, 300),
        type,
        materialDesignation: defaultDesignationFor(type),
        // Everything arriving by link lands unclassified, the same rule the
        // bulk import follows: whoever finds a link is rarely whoever decides
        // its subject, and the catalogue can filter for these.
        category: UNCATEGORISED,
        publisher: draft.publisher?.slice(0, 200) ?? null,
        publishedYear: draft.year,
        description: draft.abstract?.slice(0, 4000) ?? null,
        coverColor: coverColorFor((provider ?? "") + draft.title),
        digital: true,
        digitalUrl: canonical,
        provider,
      },
      select: { id: true, title: true, author: true, publishedYear: true, publisher: true, type: true },
    });

    return {
      status: "created",
      id: created.id,
      title: created.title,
      authors: created.author,
      year: created.publishedYear,
      publisher: created.publisher,
      type: created.type,
      provenance: resolved.provenance,
      fetchFailure: resolved.fetchFailure,
      links: linksFor(created.id, canonical, provider),
    };
  } catch (e) {
    // digitalUrl is @unique. Losing the race to a simultaneous submission of
    // the same link is a duplicate, not an error: report what is already there.
    if (isUniqueViolation(e)) {
      const raced = await findExisting(canonical);
      if (raced) {
        return {
          status: "duplicate",
          id: raced.id,
          title: raced.title,
          authors: raced.author,
          year: raced.publishedYear,
          publisher: raced.publisher,
          type: raced.type,
          provenance: "Someone added that link a moment ago.",
          fetchFailure: null,
          links: linksFor(raced.id, raced.digitalUrl, raced.provider),
        };
      }
    }
    throw e;
  }
}

/**
 * Find an existing record for a URL, matching on the canonical form.
 *
 * Checks the exact stored value first because that is an indexed unique lookup,
 * then the canonical form, then the same URL under the other scheme. Records
 * predating canonicalisation were stored as pasted, so an exact-only check
 * would create a second copy of something the library already has.
 */
async function findExisting(url: string) {
  const canonical = canonicaliseUrl(url);
  const alternates = new Set<string>([url, canonical]);
  // http/https of the same address are the same document in practice, even
  // though canonicaliseUrl keeps them apart (they are different origins).
  if (canonical.startsWith("https://")) alternates.add(`http://${canonical.slice(8)}`);
  if (canonical.startsWith("http://")) alternates.add(`https://${canonical.slice(7)}`);

  return prisma.resource.findFirst({
    where: { digitalUrl: { in: [...alternates] } },
    select: {
      id: true,
      title: true,
      author: true,
      publishedYear: true,
      publisher: true,
      type: true,
      digitalUrl: true,
      provider: true,
    },
  });
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: string }).code === "P2002"
  );
}

/**
 * Failures that mean "not a legitimate public resource", so nothing is saved.
 *
 * Distinct from the failures below, which mean "a real page that could not be
 * read right now" and still produce a record for a librarian to correct. The
 * difference matters: a site being down is a temporary fact about the world, a
 * link resolving to a private address is a permanent fact about the link.
 */
export const REFUSAL_TEXT = {
  blocked:
    "That address resolves to a private or internal network, so it cannot be catalogued as a library resource.",
  scheme: "Only http and https links can be catalogued.",
  port: "That link uses a port this system will not open. Public pages are served on 80 or 443.",
} as const;

/** Wording for a page that could not be read, shown beside the saved record. */
export const FETCH_FAILURE_TEXT: Record<FetchFailure, string> = {
  blocked: "That address resolves to a private network, so it was not fetched.",
  scheme: "Only http and https links can be read.",
  port: "That link uses a port the fetcher does not open.",
  timeout: "The site did not respond in time.",
  "too-many-hops": "The link redirected too many times.",
  network: "The site could not be reached.",
  status: "The site returned an error for that page.",
  "content-type": "That link is not a web page, so no details could be read from it.",
  "no-location": "The site sent a redirect with nowhere to go.",
};
