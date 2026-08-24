/**
 * Search-term processing (SDD rows 10-11). Pure so it's tsx-testable; callers
 * load the stop-word and variant lists and pass them in.
 *
 * A query is tokenised, stop words are dropped, and each surviving token is
 * expanded through the variant-spelling pairs (both directions). The result
 * is one prisma clause per token (the caller ANDs them), where each token
 * matches if ANY of its spellings appears in ANY of the searched fields.
 *
 * "the great gatsby" with stop word "the" becomes two token clauses (great,
 * gatsby) instead of one exact-phrase substring, so word order and clutter
 * words stop mattering.
 */

export type VariantPair = { word: string; variant: string };

/** Lowercased word tokens; punctuation splits, so "children's" → children, s. */
export function tokenise(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 12); // a search box, not a document
}

/** Build the expansion index once per request: word → every spelling of it. */
export function buildVariantIndex(pairs: VariantPair[]): Map<string, string[]> {
  // Union groups so a→b and b→c all see each other.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const p of pairs) {
    const w = p.word.toLowerCase().trim();
    const v = p.variant.toLowerCase().trim();
    if (!w || !v || w === v) continue;
    if (!parent.has(w)) parent.set(w, w);
    if (!parent.has(v)) parent.set(v, v);
    union(w, v);
  }
  const groups = new Map<string, string[]>();
  for (const key of parent.keys()) {
    const root = find(key);
    const g = groups.get(root) ?? [];
    g.push(key);
    groups.set(root, g);
  }
  const index = new Map<string, string[]>();
  for (const g of groups.values()) {
    const sorted = [...new Set(g)].sort();
    for (const member of sorted) index.set(member, sorted);
  }
  return index;
}

export type TokenPlan = {
  /** Tokens that survived the stop list, each with all its spellings. */
  tokens: { token: string; spellings: string[] }[];
  /** True when every token was a stop word, so the caller should fall back. */
  allStopped: boolean;
};

export function planTokens(
  q: string,
  stopWords: ReadonlySet<string>,
  variantIndex: Map<string, string[]>,
): TokenPlan {
  const raw = tokenise(q);
  const kept = raw.filter((t) => !stopWords.has(t));
  if (raw.length > 0 && kept.length === 0) return { tokens: [], allStopped: true };
  return {
    tokens: kept.map((token) => ({
      token,
      spellings: variantIndex.get(token) ?? [token],
    })),
    allStopped: false,
  };
}

/**
 * Prisma where-clauses for a free-text search over `fields`: one AND entry
 * per token, each an OR of every spelling × field. Returns null when the
 * query has no usable tokens (caller keeps its raw-phrase fallback).
 */
export function searchClauses(
  q: string,
  fields: string[],
  stopWords: ReadonlySet<string>,
  variantIndex: Map<string, string[]>,
): Record<string, unknown>[] | null {
  const plan = planTokens(q, stopWords, variantIndex);
  if (plan.allStopped || plan.tokens.length === 0) return null;
  return plan.tokens.map(({ spellings }) => ({
    OR: spellings.flatMap((s) =>
      fields.map((f) => ({ [f]: { contains: s, mode: "insensitive" } })),
    ),
  }));
}
