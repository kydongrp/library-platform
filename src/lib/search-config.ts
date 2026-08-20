import { prisma } from "@/lib/db";
import { buildVariantIndex, searchClauses } from "@/lib/search-terms";

/**
 * The prisma where-fragment for a free-text bib search, with the managed stop
 * words dropped and variant spellings expanded (SDD rows 10-11). Falls back
 * to the raw phrase when every token is a stop word, so searching "the"
 * still behaves rather than matching everything or nothing surprising.
 */
export async function bibSearchWhere(
  q: string,
  fields: string[],
): Promise<Record<string, unknown>> {
  const [stops, variants] = await Promise.all([
    prisma.stopWord.findMany({ select: { word: true } }),
    prisma.variantSpelling.findMany({ select: { word: true, variant: true } }),
  ]);
  const clauses = searchClauses(
    q,
    fields,
    new Set(stops.map((s) => s.word)),
    buildVariantIndex(variants),
  );
  if (!clauses) {
    return { OR: fields.map((f) => ({ [f]: { contains: q, mode: "insensitive" } })) };
  }
  return { AND: clauses };
}
