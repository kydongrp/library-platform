// Client-safe module: template vocabulary and defaults. No server imports —
// the notify() side of templating lives in src/lib/templates.ts.

export type TemplateVars = Record<string, string>;

/** Substitute {{placeholder}} tokens; unknown tokens are left visible. */
export function renderTemplate(text: string, vars: TemplateVars): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, key) => vars[key] ?? m);
}

/** Placeholders each template supports, shown as hints in the editor UI. */
export const TEMPLATE_PLACEHOLDERS: Record<string, string[]> = {
  PREDUE: ["memberName", "resourceTitle", "dueDate"],
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
    body: "Hi {{memberName}},\n\nGood news — “{{resourceTitle}}” is ready for you at the circulation desk. Please collect it by {{expiryDate}}.",
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
    body: "Hi {{memberName}},\n\nYou borrowed “{{resourceTitle}}” — it's due back on {{dueDate}}.",
  },
  {
    code: "RETURN",
    name: "Return confirmation",
    subject: "Returned: “{{resourceTitle}}”",
    body: "Hi {{memberName}},\n\nThanks — “{{resourceTitle}}” has been returned.",
  },
  {
    code: "RECALL",
    name: "Loan recall",
    subject: "Recall: please return “{{resourceTitle}}” by {{newDueDate}}",
    body: "Hi {{memberName}},\n\nThe library has recalled “{{resourceTitle}}”. Your new due date is {{newDueDate}}. Please return it by then — thank you for understanding.",
    emailEnabled: true,
  },
  {
    code: "DIGITAL_AVAILABLE",
    name: "Digital seat available",
    subject: "Now available: “{{resourceTitle}}”",
    body: "Hi {{memberName}},\n\nA licence for “{{resourceTitle}}” has become available. Borrow it from the portal — seats are first come, first served.",
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
