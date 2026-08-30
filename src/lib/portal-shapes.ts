// Public JSON shapes for the Portal API. One mapper so every endpoint
// serialises resources identically, and so member/staff data can never
// leak by accident: only the fields named here leave the system.

import { proxiedUrl } from "@/lib/proxy-link";
import { type LinkState } from "@/lib/link-state";

type ResourceWithCopies = {
  id: string;
  title: string;
  subtitle: string | null;
  author: string;
  isbn: string | null;
  type: string;
  materialDesignation: string;
  category: string;
  publisher: string | null;
  publishedYear: number | null;
  language: string;
  description: string | null;
  digital: boolean;
  digitalUrl: string | null;
  provider: string | null;
  licenseSeats: number | null;
  editorsPick: boolean;
  epBlurb: string | null;
  epPickedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  copies: { status: string }[];
};

export type PublicResource = ReturnType<typeof toPublicResource>;

/**
 * Serialise one resource for the portal.
 *
 * `access` is the nightly scan's verdict, from src/lib/link-state.ts, and is
 * null when the link has never been scanned. It is a parameter rather than
 * something read here because this module is a pure mapper and each route
 * fetches its own page of checks in one query.
 */
export function toPublicResource(r: ResourceWithCopies, access: LinkState | null = null) {
  // A link the last scan found dead is not offered. The library already knows
  // a learner clicking it gets a 404, and handing it over anyway spends their
  // time to tell them something it could have said itself. curation.ts has
  // taken the same line for Editor's Pick since it was written.
  //
  // accessStatus is sent alongside so the portal can say WHY there is no link,
  // rather than rendering a title that silently looks like it has no full text.
  const withheld = access === "BROKEN";
  return {
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    author: r.author,
    isbn: r.isbn,
    type: r.type,
    /** MONOGRAPH | SERIAL: bib-level designation, for portal facets. */
    materialDesignation: r.materialDesignation,
    category: r.category,
    publisher: r.publisher,
    publishedYear: r.publishedYear,
    language: r.language,
    description: r.description,
    digital: r.digital,
    // Wrapped in the library's authenticating proxy when one is configured,
    // so a learner reaches licensed full text instead of the paywall. The
    // stored URL stays canonical; see src/lib/proxy-link.ts.
    accessUrl: withheld ? null : proxiedUrl(r.digitalUrl, r.provider),
    /**
     * OK          the scan retrieved the page
     * UNVERIFIED  the provider answered without serving it (subscription wall,
     *             bot gate); the link is still offered, it usually works in a
     *             browser
     * BROKEN      dead at the last scan; accessUrl is withheld
     * null        this title has no access URL, or it has never been scanned
     */
    accessStatus: r.digitalUrl ? access : null,
    provider: r.provider,
    editorsPick: r.editorsPick,
    editorsPickBlurb: r.editorsPick ? r.epBlurb : null,
    editorsPickAt: r.editorsPick ? r.epPickedAt : null,
    availability: r.digital
      ? { kind: "digital" as const, concurrentSeats: r.licenseSeats }
      : {
          kind: "physical" as const,
          copiesTotal: r.copies.length,
          copiesAvailable: r.copies.filter((c) => c.status === "AVAILABLE").length,
        },
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** The `select` matching ResourceWithCopies. Pass it to prisma queries. */
export const publicResourceSelect = {
  id: true, title: true, subtitle: true, author: true, isbn: true,
  type: true, materialDesignation: true, category: true, publisher: true, publishedYear: true,
  language: true, description: true, digital: true, digitalUrl: true,
  provider: true, licenseSeats: true, editorsPick: true, epBlurb: true,
  epPickedAt: true, createdAt: true, updatedAt: true,
  copies: { select: { status: true } },
} as const;
