// Bulk member import: parse a CSV of users into validated member rows.
// Pure (no prisma) so it's tsx-testable; the members action does the writes.
// Lenient header aliases, same philosophy as the resource bulk importer.

import { parseCsv } from "@/lib/bulk-import";
import { MEMBER_TYPES, MEMBER_LANGUAGES } from "@/lib/constants";

export type MemberRow = {
  name: string;
  email: string;
  memberType: string;
  status: string;
  phone: string | null;
  language: string;
  location: string | null;
  department: string | null;
  maxLoans: number;
};

export type MemberParseResult = {
  rows: MemberRow[];
  skipped: { line: number; reason: string }[];
  warnings: string[];
};

const MAX_ROWS = 20_000;

const ALIASES: Record<string, string[]> = {
  name: ["name", "full name", "fullname", "member name", "member"],
  email: ["email", "e-mail", "email address", "mail"],
  memberType: ["membertype", "member type", "type", "member_type", "category", "role"],
  status: ["status", "member status", "member_status"],
  phone: ["phone", "mobile", "tel", "telephone", "phone number", "contact number", "hp"],
  language: ["language", "lang", "preferred language", "language preference", "notice language"],
  location: ["location", "site", "campus", "branch", "office"],
  department: ["department", "dept", "faculty", "school", "unit", "division"],
  maxLoans: ["maxloans", "max loans", "max_loans", "loan limit", "loanlimit"],
};

function defaultMaxLoans(memberType: string): number {
  return memberType === "STAFF" ? 10 : memberType === "EXTERNAL" ? 3 : 5;
}

const clip = (v: string, n: number) => v.trim().slice(0, n);

export function parseMemberRows(
  text: string,
  validStatuses: string[],
  defaultStatus: string,
): MemberParseResult {
  const warnings: string[] = [];
  const records = parseCsv(text.slice(0, 4_000_000));
  if (records.length === 0)
    return {
      rows: [],
      skipped: [],
      warnings: ["No data rows found. Expected a CSV with a header row including name and email."],
    };

  // Resolve which source header feeds each field.
  const headers = Object.keys(records[0]);
  const headerFor = new Map<string, string>();
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const hit = headers.find((h) => aliases.includes(h.trim().toLowerCase()));
    if (hit) headerFor.set(field, hit);
  }
  if (!headerFor.has("name") || !headerFor.has("email"))
    return {
      rows: [],
      skipped: [],
      warnings: [
        `Couldn't find the required columns. Found headers: ${headers.slice(0, 8).join(", ")} — need at least "name" and "email".`,
      ],
    };
  const get = (r: Record<string, string>, field: string) => (headerFor.has(field) ? (r[headerFor.get(field)!] ?? "").trim() : "");

  const statusByLower = new Map(validStatuses.map((s) => [s.toLowerCase(), s]));
  const langByLower = new Map((MEMBER_LANGUAGES as readonly string[]).map((l) => [l.toLowerCase(), l]));

  const rows: MemberRow[] = [];
  const skipped: { line: number; reason: string }[] = [];
  const seenEmails = new Set<string>();
  let unknownStatuses = 0;

  records.slice(0, MAX_ROWS).forEach((r, i) => {
    const line = i + 2; // 1-based + header row
    const name = clip(get(r, "name"), 200);
    const email = clip(get(r, "email"), 200).toLowerCase();
    if (!name) return skipped.push({ line, reason: "missing name" });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return skipped.push({ line, reason: `invalid email "${email.slice(0, 40)}"` });
    if (seenEmails.has(email)) return skipped.push({ line, reason: `duplicate email in file (${email})` });
    seenEmails.add(email);

    const typeRaw = get(r, "memberType").toUpperCase();
    const memberType = (MEMBER_TYPES as readonly string[]).includes(typeRaw) ? typeRaw : "STUDENT";

    const statusRaw = get(r, "status");
    let status = defaultStatus;
    if (statusRaw) {
      const matched = statusByLower.get(statusRaw.toLowerCase());
      if (matched) status = matched;
      else unknownStatuses++;
    }

    const langRaw = get(r, "language");
    const language = langByLower.get(langRaw.toLowerCase()) ?? "English";

    const maxRaw = get(r, "maxLoans");
    const maxParsed = maxRaw ? parseInt(maxRaw, 10) : NaN;
    const maxLoans =
      Number.isInteger(maxParsed) && maxParsed >= 1 && maxParsed <= 50
        ? maxParsed
        : defaultMaxLoans(memberType);

    rows.push({
      name,
      email,
      memberType,
      status,
      phone: clip(get(r, "phone"), 40) || null,
      language,
      location: clip(get(r, "location"), 120) || null,
      department: clip(get(r, "department"), 120) || null,
      maxLoans,
    });
  });

  if (records.length > MAX_ROWS)
    warnings.push(`File has ${records.length} rows — only the first ${MAX_ROWS} were read.`);
  if (unknownStatuses > 0)
    warnings.push(`${unknownStatuses} row${unknownStatuses === 1 ? "" : "s"} had a status that isn't defined — defaulted to "${defaultStatus}".`);

  return { rows, skipped, warnings };
}
