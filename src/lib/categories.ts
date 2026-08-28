/**
 * Areas of Interest (the catalogue's "Category" field), as a managed code list.
 *
 * This used to be a fixed array in constants.ts. Staff now add their own from
 * the catalogue form, which means the allowed set is a database question rather
 * than a compile-time one, and every place that validated against the constant
 * has to ask here instead.
 *
 * Two behaviours worth stating, both copied from the member code lists:
 *
 *   - Removing a category does NOT touch resources that already use it. The
 *     list drives the form's choices; a resource keeps its stored value. So a
 *     category can disappear from the dropdown while records still carry it,
 *     and the catalogue filter still has to offer those values.
 *
 *   - The seed list is retained as SEED_CATEGORIES. An empty table means "not
 *     seeded yet", not "no categories allowed", so listCategories falls back to
 *     the seed rather than returning nothing and emptying every dropdown.
 */
import { prisma } from "@/lib/db";
import { SEED_CATEGORIES, UNCATEGORISED } from "@/lib/constants";

export { UNCATEGORISED };

export const CATEGORY_NAME_MAX = 60;

/**
 * Every category name that should appear in a dropdown, in display order.
 *
 * The union of the managed list and any value already stored on a resource, so
 * a record whose category was later removed from the list still round-trips
 * through the edit form instead of being silently reassigned on save.
 */
export async function listCategories(): Promise<string[]> {
  const [rows, used] = await Promise.all([
    prisma.resourceCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.resource.findMany({
      distinct: ["category"],
      select: { category: true },
    }),
  ]);

  const managed = rows.map((r) => r.name);
  const base = managed.length > 0 ? managed : [...SEED_CATEGORIES];
  const inUse = used.map((r) => r.category).filter(Boolean);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...base, ...inUse]) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  // Uncategorised is where imports land, so it must always be selectable.
  if (!seen.has(UNCATEGORISED.toLowerCase())) out.push(UNCATEGORISED);
  return out;
}

/**
 * Resolve a submitted category to a stored value.
 *
 * Case-insensitive against the current list, so "science" saves as "Science"
 * rather than creating a near-duplicate. An unknown value falls back to
 * Uncategorised instead of being written through: the column is free text at
 * the database level, and letting arbitrary strings in is how a code list
 * becomes forty spellings of the same thing.
 */
export function resolveCategory(raw: unknown, allowed: readonly string[]): string {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return UNCATEGORISED;
  const hit = allowed.find((c) => c.toLowerCase() === v.toLowerCase());
  return hit ?? UNCATEGORISED;
}

/** Normalise a name for storage: collapse whitespace, cap length. */
export function normaliseCategoryName(raw: unknown): string {
  return typeof raw === "string"
    ? raw.replace(/\s+/g, " ").trim().slice(0, CATEGORY_NAME_MAX)
    : "";
}

/**
 * Ensure the managed table holds the seed list.
 *
 * Called by the build's schema sync so a fresh deployment has the original
 * categories rather than an empty dropdown. Idempotent: existing rows are left
 * alone, including any the staff renamed.
 */
export async function seedCategories(): Promise<number> {
  let created = 0;
  for (const [i, name] of [UNCATEGORISED, ...SEED_CATEGORIES].entries()) {
    const existing = await prisma.resourceCategory.findUnique({ where: { name } });
    if (existing) continue;
    await prisma.resourceCategory.create({ data: { name, sortOrder: i } });
    created++;
  }
  return created;
}
