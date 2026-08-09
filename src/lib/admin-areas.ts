// Client-safe module: area vocabulary for the admin access matrix.
// No server imports here — client components import these directly.

export const ADMIN_AREAS = [
  "DASHBOARD",
  "CIRCULATION",
  "CATALOGUE",
  "MEMBERS",
  "LOANS",
  "RESERVATIONS",
  "POLICIES",
  "TEMPLATES",
  "REPORTS",
  "BATCH",
  "ADMIN",
] as const;
export type AdminArea = (typeof ADMIN_AREAS)[number];

export const AREA_LABELS: Record<string, string> = {
  DASHBOARD: "Dashboard",
  CIRCULATION: "Circulation Desk",
  CATALOGUE: "Catalogue",
  MEMBERS: "Members",
  LOANS: "Current Loans",
  RESERVATIONS: "Reservations",
  POLICIES: "Loan Policies",
  TEMPLATES: "Email Templates",
  REPORTS: "Reports",
  BATCH: "Batch Processes",
  ADMIN: "Admin Settings",
};
