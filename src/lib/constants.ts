// Shared domain vocabulary. SQLite has no enums, so these arrays are the
// single source of truth for the allowed string values used across the app.

export const CATEGORIES = [
  "Technology",
  "Business",
  "Science",
  "Arts",
  "History",
  "Health",
  "Fiction",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const RESOURCE_TYPES = [
  "BOOK",
  "EBOOK",
  "AUDIOBOOK",
  "JOURNAL",
  "MAGAZINE",
  "NEWSPAPER",
  "CONFERENCE",
  "STANDARD",
  "DVD",
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const RESOURCE_TYPE_LABELS: Record<string, string> = {
  BOOK: "Book",
  EBOOK: "E-book",
  AUDIOBOOK: "Audiobook",
  JOURNAL: "Journal / Transactions",
  MAGAZINE: "Magazine",
  NEWSPAPER: "Newspaper",
  CONFERENCE: "Conference paper",
  STANDARD: "Standard",
  DVD: "DVD",
};

// Bib-level material designation, mirroring how the Vibrante ILS tags every
// record. A SERIAL is issued in a continuing sequence (journal, magazine,
// newspaper); a MONOGRAPH is a standalone work.
export const MATERIAL_DESIGNATIONS = ["MONOGRAPH", "SERIAL"] as const;
export type MaterialDesignation = (typeof MATERIAL_DESIGNATIONS)[number];

export const MATERIAL_DESIGNATION_LABELS: Record<string, string> = {
  MONOGRAPH: "Monograph",
  SERIAL: "Serial",
};

/** Types that are serials by nature, so they set a record's default designation. */
export const SERIAL_TYPES = new Set(["JOURNAL", "MAGAZINE", "NEWSPAPER"]);

export function defaultDesignationFor(type: string): MaterialDesignation {
  return SERIAL_TYPES.has(type) ? "SERIAL" : "MONOGRAPH";
}

// Digital types grant instant access and never have physical copies.
// Scholarly publication formats (commonly supplied by IEEE Xplore et al.)
// are accessed online rather than held as physical copies.
export const DIGITAL_TYPES = new Set([
  "EBOOK",
  "AUDIOBOOK",
  "CONFERENCE",
  "STANDARD",
]);

// Known external content providers, offered as quick-pick options wherever an
// admin tags a resource, subscription or usage figure.
//
// This is the ONLY list. It used to be duplicated as MANUAL_PROVIDERS in
// scholarly.ts, which meant adding a provider in one place left the other
// dropdowns without it.
//
// The field is free text everywhere (datalists here, selects with an "Other…"
// option on the import screens), so this list is a convenience and never a
// constraint. Names must match the strings already stored, because `provider`
// is the only join between Subscription, Resource and UsageStat: renaming an
// entry here silently detaches that provider's cost-per-use figures. That is
// why "MIT OCW" keeps its abbreviated form.
//
// Grouped so the select stays navigable as the list grows. Prune freely: a
// provider nobody subscribes to is just a line an admin scrolls past.
export const PROVIDER_GROUPS = [
  {
    // The very first provider in the very first group is what the manual and
    // bulk import forms preselect, so IEEE Xplore leads: it is the largest
    // holding and the only registered subscription. Reordering this group
    // changes what admins get by default.
    label: "Defence, aerospace & engineering",
    providers: [
      "IEEE Xplore",
      "Janes",
      "IHS Markit",
      "Knovel",
      "SPIE Digital Library",
      "ASME Digital Collection",
      "AIAA Aerospace Research Central",
      "SAE Mobilus",
      "Aviation Week Network",
    ],
  },
  {
    label: "Standards",
    providers: [
      "ASTM Compass",
      "BSI Knowledge",
      "IEC Webstore",
      "ISO",
      "Singapore Standards eShop",
      "Techstreet",
    ],
  },
  {
    label: "Journals & books",
    providers: [
      "ScienceDirect",
      "SpringerLink",
      "Wiley Online Library",
      "Taylor & Francis Online",
      "SAGE Journals",
      "Cambridge Core",
      "Oxford Academic",
      "Emerald Insight",
      "MIT Press Direct",
      "ACM Digital Library",
    ],
  },
  {
    label: "Databases & aggregators",
    providers: [
      "JSTOR",
      "ProQuest",
      "EBSCOhost",
      "Gale",
      "Scopus",
      "Web of Science",
      "Statista",
      "NLB eResources",
    ],
  },
  {
    label: "Professional & skills learning",
    providers: [
      "O'Reilly Learning",
      "LinkedIn Learning",
      "Coursera",
      "Udemy Business",
      "Harvard Business Publishing",
      "MIT OCW",
    ],
  },
  {
    label: "Open access & metadata",
    providers: ["Crossref", "arXiv", "DOAJ", "OpenAlex"],
  },
] as const;

/** Flat list of every provider, for datalists and plain membership checks. */
export const PROVIDERS: string[] = PROVIDER_GROUPS.flatMap((g) => [...g.providers]);

export const MEMBER_TYPES = ["STUDENT", "STAFF", "EXTERNAL"] as const;
export type MemberType = (typeof MEMBER_TYPES)[number];

export const MEMBER_TYPE_LABELS: Record<string, string> = {
  STUDENT: "Student",
  STAFF: "Staff",
  EXTERNAL: "External",
};

// Notice/preference languages offered on member records (SG official languages).
export const MEMBER_LANGUAGES = ["English", "Chinese", "Malay", "Tamil"] as const;

// Circulation rules now live in the LoanPolicy table (see src/lib/policies.ts),
// editable from Admin → Loan Policies.

export const COPY_STATUSES = [
  "AVAILABLE",
  "ON_LOAN",
  "RESERVED",
  "LOST",
  "MAINTENANCE",
] as const;

export const COPY_STATUS_LABELS: Record<string, string> = {
  AVAILABLE: "Available",
  ON_LOAN: "On loan",
  RESERVED: "Reserved",
  LOST: "Lost",
  MAINTENANCE: "Maintenance",
};
