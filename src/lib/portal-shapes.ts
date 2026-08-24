// Public JSON shapes for the Portal API. One mapper so every endpoint
// serialises resources identically, and so member/staff data can never
// leak by accident: only the fields named here leave the system.

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

export function toPublicResource(r: ResourceWithCopies) {
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
    accessUrl: r.digitalUrl,
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
