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
  CONFERENCE: "Conference paper",
  STANDARD: "Standard",
  DVD: "DVD",
};

// Digital types grant instant access and never have physical copies.
// Scholarly publication formats (commonly supplied by IEEE Xplore et al.)
// are accessed online rather than held as physical copies.
export const DIGITAL_TYPES = new Set([
  "EBOOK",
  "AUDIOBOOK",
  "CONFERENCE",
  "STANDARD",
]);

// Known external subscription providers, offered as quick-pick options.
export const PROVIDERS = ["IEEE Xplore", "Janes", "Knovel", "IHS Markit", "ScienceDirect", "JSTOR", "ACM Digital Library", "ProQuest", "SPIE Digital Library"];

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
