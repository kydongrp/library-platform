/**
 * Member types (the "Type" field on a member record), as a managed code list.
 *
 * Same shape as src/lib/categories.ts and for the same reason: the vocabulary
 * belongs to the institution, not to the code. DSTA's categories are not the
 * next client's, and a fixed enum would mean a deployment for every new one.
 *
 * Two things to know:
 *
 *   - `name` is stored on Member.memberType and referenced by
 *     LoanPolicy.memberType. Never rewrite a name to change its wording; edit
 *     the label. Renaming a name orphans every member and loan policy using it,
 *     and the loan matrix would silently fall back to the DEFAULT policy.
 *
 *   - The list offered always includes any value already in use, so the three
 *     original types (STUDENT, STAFF, EXTERNAL) still round-trip through the
 *     member form while members remain on them, and are simply absent once
 *     nobody is.
 */
import { prisma } from "@/lib/db";
import { SEED_MEMBER_TYPES, MEMBER_TYPE_LABELS } from "@/lib/constants";

export type MemberTypeOption = { name: string; label: string };

/**
 * Every member type that should appear in a dropdown, in display order.
 *
 * An empty table means "not seeded yet", not "no types allowed", so it falls
 * back to the seed rather than returning nothing and emptying the dropdown on
 * the member form.
 */
export async function listMemberTypes(): Promise<MemberTypeOption[]> {
  const [rows, used] = await Promise.all([
    prisma.memberTypeDef.findMany({ orderBy: [{ sortOrder: "asc" }, { label: "asc" }] }),
    prisma.member.findMany({ distinct: ["memberType"], select: { memberType: true } }),
  ]);

  const managed: MemberTypeOption[] =
    rows.length > 0
      ? rows.map((r) => ({ name: r.name, label: r.label }))
      : SEED_MEMBER_TYPES.map((t) => ({ name: t.name, label: t.label }));

  const seen = new Set(managed.map((t) => t.name));
  const out = [...managed];

  // Anything a member is actually on must stay selectable, or editing that
  // member would silently reassign them on save.
  for (const { memberType } of used) {
    if (!memberType || seen.has(memberType)) continue;
    seen.add(memberType);
    out.push({
      name: memberType,
      label: MEMBER_TYPE_LABELS[memberType] ?? memberType,
    });
  }
  return out;
}

/** The value a new member gets when nothing is chosen. */
export async function defaultMemberType(): Promise<string> {
  const list = await listMemberTypes();
  return list[0]?.name ?? SEED_MEMBER_TYPES[0].name;
}

/**
 * Resolve a submitted type to a stored value.
 *
 * Falls back to the first offered type rather than writing an arbitrary string,
 * because Member.memberType is free text at the database level and the loan
 * matrix keys on it: an unrecognised value would quietly take the DEFAULT
 * policy for the rest of that member's life.
 */
export function resolveMemberType(raw: unknown, allowed: readonly MemberTypeOption[]): string {
  const v = typeof raw === "string" ? raw.trim() : "";
  const hit = allowed.find((t) => t.name === v) ?? allowed.find((t) => t.name.toLowerCase() === v.toLowerCase());
  return hit?.name ?? allowed[0]?.name ?? SEED_MEMBER_TYPES[0].name;
}
