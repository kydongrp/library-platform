// Client-safe MARC vocabulary. No server imports — the cataloguing editor is
// a client component and must not drag Prisma into the browser bundle.

export type SubfieldDef = { code: string; label: string; repeatable?: boolean };

export type TagDefSeed = {
  tag: string;
  alias?: string;
  label: string;
  description?: string;
  repeatable?: boolean;
  isControl?: boolean;
  subfields?: SubfieldDef[];
  local?: boolean;
  sortOrder: number;
};

/**
 * The starter tag set. Staff can add, retitle or remove any of these from
 * Information Context — this is a seed, not a hard-coded schema.
 *
 * The five DSTA-specific tags the live system uses (StandardNo,
 * StandardsforITT, ChapterName, DomainCode, POC) live in the 9XX local-use
 * block, which keeps exported records valid MARC 21 while still round-tripping
 * the local data that feeds the Standards for ITT curation pages.
 */
export const DEFAULT_TAG_DEFS: TagDefSeed[] = [
  // --- Control fields ---
  { tag: "001", label: "Control Number", isControl: true, sortOrder: 10,
    description: "System control number for the record." },
  { tag: "003", label: "Control Number Identifier", isControl: true, sortOrder: 20 },
  { tag: "005", label: "Date and Time of Latest Transaction", isControl: true, sortOrder: 30 },
  { tag: "007", label: "Physical Description Fixed Field", isControl: true, repeatable: true, sortOrder: 40 },
  { tag: "008", label: "Fixed-Length Data Elements", isControl: true, sortOrder: 50 },

  // --- Numbers and codes ---
  { tag: "020", label: "International Standard Book Number", alias: "ISBN", repeatable: true, sortOrder: 100,
    subfields: [{ code: "a", label: "ISBN" }, { code: "c", label: "Terms of availability" }, { code: "q", label: "Qualifying information" }] },
  { tag: "022", label: "International Standard Serial Number", alias: "ISSN", repeatable: true, sortOrder: 110,
    subfields: [{ code: "a", label: "ISSN" }] },
  { tag: "024", label: "Other Standard Identifier", repeatable: true, sortOrder: 120,
    subfields: [{ code: "a", label: "Standard number" }, { code: "2", label: "Source of number" }] },
  { tag: "040", label: "Cataloguing Source", sortOrder: 130,
    subfields: [{ code: "a", label: "Original cataloguing agency" }, { code: "b", label: "Language of cataloguing" }, { code: "c", label: "Transcribing agency" }] },
  { tag: "041", label: "Language Code", repeatable: true, sortOrder: 140,
    subfields: [{ code: "a", label: "Language code of text", repeatable: true }] },

  // --- Main entry ---
  { tag: "100", label: "Main Entry — Personal Name", alias: "Author", sortOrder: 200,
    description: "The primary author. Use 700 for additional authors.",
    subfields: [{ code: "a", label: "Personal name" }, { code: "d", label: "Dates" }, { code: "e", label: "Relator term" }, { code: "0", label: "Authority record control number" }] },
  { tag: "110", label: "Main Entry — Corporate Name", sortOrder: 210,
    subfields: [{ code: "a", label: "Corporate name" }, { code: "b", label: "Subordinate unit" }] },
  { tag: "111", label: "Main Entry — Meeting Name", sortOrder: 220,
    subfields: [{ code: "a", label: "Meeting name" }, { code: "d", label: "Date of meeting" }] },

  // --- Title and edition ---
  { tag: "245", label: "Title Statement", alias: "Title", sortOrder: 300,
    description: "Indicator 1: title added entry. Indicator 2: characters to skip in filing (e.g. 4 for 'The ').",
    subfields: [{ code: "a", label: "Title" }, { code: "b", label: "Remainder of title (subtitle)" }, { code: "c", label: "Statement of responsibility" }, { code: "n", label: "Number of part" }, { code: "p", label: "Name of part" }] },
  { tag: "246", label: "Varying Form of Title", repeatable: true, sortOrder: 310,
    subfields: [{ code: "a", label: "Title proper" }] },
  { tag: "250", label: "Edition Statement", sortOrder: 320,
    subfields: [{ code: "a", label: "Edition statement" }] },
  { tag: "264", label: "Production, Publication, Distribution", alias: "Publication", repeatable: true, sortOrder: 330,
    description: "Indicator 2: 1 = publication, 2 = distribution, 3 = manufacture, 4 = copyright.",
    subfields: [{ code: "a", label: "Place" }, { code: "b", label: "Publisher" }, { code: "c", label: "Date" }] },
  { tag: "300", label: "Physical Description", repeatable: true, sortOrder: 340,
    subfields: [{ code: "a", label: "Extent" }, { code: "b", label: "Other physical details" }, { code: "c", label: "Dimensions" }] },
  { tag: "490", label: "Series Statement", repeatable: true, sortOrder: 350,
    subfields: [{ code: "a", label: "Series statement" }, { code: "v", label: "Volume number" }] },

  // --- Notes ---
  { tag: "500", label: "General Note", repeatable: true, sortOrder: 400,
    subfields: [{ code: "a", label: "General note" }] },
  { tag: "504", label: "Bibliography Note", repeatable: true, sortOrder: 410,
    subfields: [{ code: "a", label: "Bibliography note" }] },
  { tag: "505", label: "Formatted Contents Note", repeatable: true, sortOrder: 420,
    subfields: [{ code: "a", label: "Formatted contents note" }] },
  { tag: "520", label: "Summary", alias: "Abstract", repeatable: true, sortOrder: 430,
    subfields: [{ code: "a", label: "Summary, etc." }] },

  // --- Subject access ---
  { tag: "650", label: "Subject Added Entry — Topical Term", alias: "Subject", repeatable: true, sortOrder: 500,
    description: "Indicator 2: 0 = LCSH, 4 = source not specified (local).",
    subfields: [{ code: "a", label: "Topical term" }, { code: "x", label: "General subdivision", repeatable: true }, { code: "2", label: "Source of heading" }, { code: "0", label: "Authority record control number" }] },
  { tag: "651", label: "Subject Added Entry — Geographic Name", repeatable: true, sortOrder: 510,
    subfields: [{ code: "a", label: "Geographic name" }] },

  // --- Added entries and links ---
  { tag: "700", label: "Added Entry — Personal Name", alias: "Co-author", repeatable: true, sortOrder: 600,
    subfields: [{ code: "a", label: "Personal name" }, { code: "e", label: "Relator term" }, { code: "0", label: "Authority record control number" }] },
  { tag: "710", label: "Added Entry — Corporate Name", repeatable: true, sortOrder: 610,
    subfields: [{ code: "a", label: "Corporate name" }] },
  { tag: "856", label: "Electronic Location and Access", alias: "Access URL", repeatable: true, sortOrder: 700,
    description: "Indicator 1: 4 = HTTP. Indicator 2: 0 = resource itself, 1 = version of resource.",
    subfields: [{ code: "u", label: "URI" }, { code: "y", label: "Link text" }, { code: "z", label: "Public note" }, { code: "3", label: "Materials specified" }] },

  // --- DSTA local block (9XX) ---
  { tag: "950", alias: "StandardNo", label: "Standard Number (local)", local: true, repeatable: true, sortOrder: 900,
    description: "Local: the standard's own designation, e.g. MIL-STD-810H.",
    subfields: [{ code: "a", label: "Standard number" }, { code: "b", label: "Issuing body" }] },
  { tag: "951", alias: "StandardsforITT", label: "Standards for ITT (local)", local: true, repeatable: true, sortOrder: 910,
    description: "Local: flags the record for the Standards for ITT curation page on the Learner Portal.",
    subfields: [{ code: "a", label: "ITT category" }, { code: "b", label: "Applicability note" }] },
  { tag: "952", alias: "ChapterName", label: "Chapter Name (local)", local: true, repeatable: true, sortOrder: 920,
    subfields: [{ code: "a", label: "Chapter name" }, { code: "n", label: "Chapter number" }] },
  { tag: "953", alias: "DomainCode", label: "Domain Code (local)", local: true, repeatable: true, sortOrder: 930,
    description: "Local: links the record to a DSTA domain code and its interest topics.",
    subfields: [{ code: "a", label: "Domain code" }, { code: "b", label: "Interest topic" }] },
  { tag: "954", alias: "POC", label: "Point of Contact (local)", local: true, repeatable: true, sortOrder: 940,
    subfields: [{ code: "a", label: "Name" }, { code: "b", label: "Email" }, { code: "c", label: "Department" }] },
];

/** Subfields carried on a stored field, as entered. */
export type Subfield = { code: string; value: string };

export function parseSubfields(raw: unknown): Subfield[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is { code?: unknown; value?: unknown } => !!s && typeof s === "object")
    .map((s) => ({ code: String(s.code ?? "").slice(0, 1), value: String(s.value ?? "") }))
    .filter((s) => s.code !== "");
}

/** "$a Perry's handbook $b 9th ed." — a compact one-line preview. */
export function formatSubfields(subs: Subfield[]): string {
  return subs.map((s) => `$${s.code} ${s.value}`).join("  ");
}

/** Blank indicators display as a visible placeholder rather than nothing. */
export function displayIndicator(ind: string): string {
  return ind === " " || ind === "" ? "_" : ind;
}

export const isControlTag = (tag: string) => /^00\d$/.test(tag);
export const isLocalTag = (tag: string) => /^9\d\d$/.test(tag);
