// Client-safe module: template vocabulary and defaults. No server imports;
// the notify() side of templating lives in src/lib/templates.ts.

export type TemplateVars = Record<string, string>;

/** Substitute {{placeholder}} tokens; unknown tokens are left visible. */
export function renderTemplate(text: string, vars: TemplateVars): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, key) => vars[key] ?? m);
}

/** Placeholders each template supports, shown as hints in the editor UI. */
export const TEMPLATE_PLACEHOLDERS: Record<string, string[]> = {
  PREDUE: ["memberName", "resourceTitle", "dueDate", "daysUntilDue"],
  OVERDUE: ["memberName", "resourceTitle", "dueDate", "daysOverdue"],
  WELCOME: ["memberName"],
  INACTIVE: ["memberName", "monthsInactive"],
  RESERVATION_READY: ["memberName", "resourceTitle", "expiryDate"],
  RESERVATION_CANCELLED: ["memberName", "resourceTitle"],
  BORROW: ["memberName", "resourceTitle", "dueDate"],
  RETURN: ["memberName", "resourceTitle"],
  RECALL: ["memberName", "resourceTitle", "newDueDate"],
  DIGITAL_AVAILABLE: ["memberName", "resourceTitle"],
  REQUEST_UPDATE: ["memberName", "requestTitle", "requestStatus"],
  SERIAL_ISSUE: ["memberName", "resourceTitle", "issueLabel"],
};

/**
 * What each placeholder resolves to, for the reference panel on the templates
 * page. Every name in TEMPLATE_PLACEHOLDERS must appear here; allPlaceholders()
 * throws if one is missing, so adding a placeholder without describing it
 * fails loudly rather than shipping an undocumented token.
 */
export const PLACEHOLDER_DOCS: Record<string, { resolvesTo: string; example: string }> = {
  memberName: { resolvesTo: "The member's full name, as held on their record", example: "Alice Tan" },
  resourceTitle: { resolvesTo: "Title of the item the notice is about", example: "Clean Code" },
  dueDate: { resolvesTo: "The loan's due date", example: "14 Sep 2026" },
  daysOverdue: { resolvesTo: "Whole days past the due date", example: "3" },
  daysUntilDue: {
    // The reminder only fires two days out, so this is 0, 1 or 2 and never
    // more. Zero means the item is due today, which is why the shipped
    // wording quotes dueDate instead of counting down.
    resolvesTo: "Whole days left before the due date, and 0 on the day itself",
    example: "2",
  },
  monthsInactive: { resolvesTo: "Months since the member's last loan", example: "6" },
  expiryDate: { resolvesTo: "Last day a held item stays on the pickup shelf", example: "20 Aug 2026" },
  newDueDate: { resolvesTo: "The earlier due date set by a recall", example: "26 Aug 2026" },
  requestTitle: { resolvesTo: "Title the member asked the library to acquire", example: "Designing Data-Intensive Applications" },
  requestStatus: { resolvesTo: "Where their request now stands", example: "Approved" },
  issueLabel: { resolvesTo: "The serial issue that arrived", example: "Vol 12, No 4" },
};

/** Placeholders every notice can use, whatever its code. */
export const UNIVERSAL_PLACEHOLDERS = ["memberName"] as const;

export type PlaceholderInfo = {
  name: string;
  resolvesTo: string;
  example: string;
  /** Template codes that supply it. Empty for none, all of them for universal. */
  usedBy: string[];
  universal: boolean;
};

/**
 * Every placeholder the system can substitute, derived from the per-template
 * lists so the two can never disagree.
 */
export function allPlaceholders(): PlaceholderInfo[] {
  const usedBy = new Map<string, string[]>();
  for (const [code, names] of Object.entries(TEMPLATE_PLACEHOLDERS)) {
    for (const name of names) {
      const list = usedBy.get(name) ?? [];
      list.push(code);
      usedBy.set(name, list);
    }
  }

  const missing = [...usedBy.keys()].filter((n) => !PLACEHOLDER_DOCS[n]);
  if (missing.length) {
    throw new Error(
      `Placeholder(s) used by a template but not described in PLACEHOLDER_DOCS: ${missing.join(", ")}`,
    );
  }

  const universal = new Set<string>(UNIVERSAL_PLACEHOLDERS);
  return [...usedBy.entries()]
    .map(([name, codes]) => ({
      name,
      resolvesTo: PLACEHOLDER_DOCS[name].resolvesTo,
      example: PLACEHOLDER_DOCS[name].example,
      usedBy: codes.sort(),
      universal: universal.has(name),
    }))
    // Universal first, then the widely available ones, then alphabetical.
    .sort((a, b) => {
      if (a.universal !== b.universal) return a.universal ? -1 : 1;
      if (a.usedBy.length !== b.usedBy.length) return b.usedBy.length - a.usedBy.length;
      return a.name.localeCompare(b.name);
    });
}

/** Placeholder names actually written into a template's subject or body. */
export function placeholdersInUse(subject: string, body: string): string[] {
  const found = new Set<string>();
  for (const text of [subject, body]) {
    for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) found.add(m[1]);
  }
  return [...found];
}

export const DEFAULT_TEMPLATES: {
  code: string;
  name: string;
  subject: string;
  body: string;
  emailEnabled?: boolean;
}[] = [
  {
    code: "PREDUE",
    name: "Due-soon reminder",
    subject: "Reminder: “{{resourceTitle}}” is due on {{dueDate}}",
    body: "Hi {{memberName}},\n\nA friendly reminder that “{{resourceTitle}}” is due back on {{dueDate}}. Renew it from My Loans if you need more time.",
    emailEnabled: true,
  },
  {
    code: "OVERDUE",
    name: "Overdue notice",
    subject: "Overdue: “{{resourceTitle}}” was due {{dueDate}}",
    body: "Hi {{memberName}},\n\n“{{resourceTitle}}” is now {{daysOverdue}} day(s) overdue (due {{dueDate}}). Please return it at your earliest convenience.",
    emailEnabled: true,
  },
  {
    code: "WELCOME",
    name: "New member welcome",
    subject: "Welcome to the Digital Library, {{memberName}}",
    body: "Hi {{memberName}},\n\nWelcome to the library! Browse the catalogue, borrow digital titles instantly, and reserve anything that's out.",
  },
  {
    code: "INACTIVE",
    name: "Inactive member nudge",
    subject: "We miss you at the library",
    body: "Hi {{memberName}},\n\nIt's been {{monthsInactive}} month(s) since your last loan. Come see what's new on the shelves!",
  },
  {
    code: "RESERVATION_READY",
    name: "Reservation ready for pickup",
    subject: "Ready for pickup: “{{resourceTitle}}”",
    body: "Hi {{memberName}},\n\nGood news: “{{resourceTitle}}” is ready for you at the circulation desk. Please collect it by {{expiryDate}}.",
    emailEnabled: true,
  },
  {
    code: "RESERVATION_CANCELLED",
    name: "Reservation cancelled",
    subject: "Your hold on “{{resourceTitle}}” was cancelled",
    body: "Hi {{memberName}},\n\nYour hold on “{{resourceTitle}}” was cancelled because it was not collected in time.",
  },
  {
    code: "BORROW",
    name: "Borrow confirmation",
    subject: "Borrowed: “{{resourceTitle}}”",
    body: "Hi {{memberName}},\n\nYou borrowed “{{resourceTitle}}”. It's due back on {{dueDate}}.",
  },
  {
    code: "RETURN",
    name: "Return confirmation",
    subject: "Returned: “{{resourceTitle}}”",
    body: "Hi {{memberName}},\n\nThank you. “{{resourceTitle}}” has been returned.",
  },
  {
    code: "RECALL",
    name: "Loan recall",
    subject: "Recall: please return “{{resourceTitle}}” by {{newDueDate}}",
    body: "Hi {{memberName}},\n\nThe library has recalled “{{resourceTitle}}”. Your new due date is {{newDueDate}}. Please return it by then. Thank you for understanding.",
    emailEnabled: true,
  },
  {
    code: "DIGITAL_AVAILABLE",
    name: "Digital seat available",
    subject: "Now available: “{{resourceTitle}}”",
    body: "Hi {{memberName}},\n\nA licence for “{{resourceTitle}}” has become available. Borrow it from the portal: seats are first come, first served.",
    emailEnabled: true,
  },
  {
    code: "REQUEST_UPDATE",
    name: "Resource request update",
    subject: "Your request “{{requestTitle}}” is {{requestStatus}}",
    body: "Hi {{memberName}},\n\nYour information resource request “{{requestTitle}}” has been updated to: {{requestStatus}}.",
  },
  {
    code: "SERIAL_ISSUE",
    name: "New serial issue arrived",
    subject: "New issue of “{{resourceTitle}}”: {{issueLabel}}",
    body: "Hi {{memberName}},\n\n{{issueLabel}} of “{{resourceTitle}}” has arrived in the library.",
    emailEnabled: true,
  },
];
