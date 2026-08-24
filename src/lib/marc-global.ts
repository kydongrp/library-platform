// Global Change Tags (Vibrant: Global Change Tags Content) edits a MARC tag
// across many records at once.
//
// Subfields are stored as JSON with no index on their contents, so there is no
// clean database filter for "every record whose 650 $a contains X". The scan is
// therefore an in-memory pass over a hard-capped candidate set, and every run
// is previewed before it is applied. There is no undo, so the change log is
// written as part of the same operation.

import { prisma } from "@/lib/db";
import { parseSubfields, type Subfield } from "@/lib/marc-tags";

/** Never touch more than this in one run, however broad the filter. */
export const GLOBAL_CHANGE_CAP = 2000;

export const OPERATIONS = ["REPLACE", "DELETE_FIELD", "ADD_SUBFIELD"] as const;
export type Operation = (typeof OPERATIONS)[number];

export const OPERATION_LABELS: Record<Operation, string> = {
  REPLACE: "Replace text in a subfield",
  DELETE_FIELD: "Delete the whole field",
  ADD_SUBFIELD: "Add a subfield to matching fields",
};

export type ChangeSpec = {
  operation: Operation;
  tag: string;
  /** Which subfield to match on; blank matches any. */
  subfieldCode?: string;
  /** Text to look for. Blank matches every instance of the tag. */
  findText?: string;
  /** Replacement text, or the value of the subfield being added. */
  replaceText?: string;
  /** Subfield code to add, for ADD_SUBFIELD. */
  addCode?: string;
  /** Match case-sensitively. */
  matchCase?: boolean;
};

export type ChangeHit = {
  fieldId: string;
  resourceId: string;
  title: string;
  before: string;
  after: string;
};

export type ChangePreview = {
  hits: ChangeHit[];
  /** Fields that matched the tag and text filter. */
  matched: number;
  /** Of those, how many would actually change. */
  changing: number;
  /** True when the candidate set hit the cap and more may exist. */
  capped: boolean;
  error?: string;
};

const fmt = (subs: Subfield[]) => subs.map((s) => `$${s.code} ${s.value}`).join("  ");

function applyToField(
  subs: Subfield[],
  spec: ChangeSpec,
): { subs: Subfield[] | null; changed: boolean } {
  const find = spec.findText ?? "";
  const flags = spec.matchCase ? "g" : "gi";
  const needle = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const matchesCode = (code: string) => !spec.subfieldCode || code === spec.subfieldCode;
  const containsFind = (value: string) =>
    find === "" ||
    (spec.matchCase ? value.includes(find) : value.toLowerCase().includes(find.toLowerCase()));

  // Does this field qualify at all?
  const qualifies = subs.some((s) => matchesCode(s.code) && containsFind(s.value));
  if (!qualifies) return { subs, changed: false };

  if (spec.operation === "DELETE_FIELD") return { subs: null, changed: true };

  if (spec.operation === "ADD_SUBFIELD") {
    const code = (spec.addCode ?? "").slice(0, 1);
    const value = spec.replaceText ?? "";
    if (!code || !value) return { subs, changed: false };
    return { subs: [...subs, { code, value }], changed: true };
  }

  // REPLACE
  if (find === "") return { subs, changed: false }; // refuse a blank find on replace
  let changed = false;
  const next = subs.map((s) => {
    if (!matchesCode(s.code)) return s;
    const replaced = s.value.replace(new RegExp(needle, flags), spec.replaceText ?? "");
    if (replaced !== s.value) changed = true;
    return { ...s, value: replaced };
  });
  // Dropping a subfield to empty would leave an invalid field; keep it out.
  const cleaned = next.filter((s) => s.value.trim() !== "");
  if (cleaned.length === 0) return { subs, changed: false };
  return { subs: cleaned, changed };
}

/** What the run would do. Never writes. */
export async function previewChange(spec: ChangeSpec, sampleSize = 40): Promise<ChangePreview> {
  if (!/^[0-9A-Z]{3}$/.test(spec.tag))
    return { hits: [], matched: 0, changing: 0, capped: false, error: "Enter a three-character tag." };
  if (spec.operation === "REPLACE" && !(spec.findText ?? "").trim())
    return { hits: [], matched: 0, changing: 0, capped: false, error: "Replacing needs text to find, otherwise every field would be rewritten." };
  if (spec.operation === "ADD_SUBFIELD" && !(spec.addCode ?? "").trim())
    return { hits: [], matched: 0, changing: 0, capped: false, error: "Choose the subfield code to add." };

  const candidates = await prisma.marcField.findMany({
    where: { tag: spec.tag },
    include: { resource: { select: { id: true, title: true } } },
    orderBy: { updatedAt: "asc" },
    take: GLOBAL_CHANGE_CAP + 1,
  });
  const capped = candidates.length > GLOBAL_CHANGE_CAP;
  const scan = capped ? candidates.slice(0, GLOBAL_CHANGE_CAP) : candidates;

  const hits: ChangeHit[] = [];
  let matched = 0;
  let changing = 0;
  for (const f of scan) {
    const subs = parseSubfields(f.subfields);
    const { subs: next, changed } = applyToField(subs, spec);
    if (!changed) continue;
    matched++;
    changing++;
    if (hits.length < sampleSize) {
      hits.push({
        fieldId: f.id,
        resourceId: f.resource.id,
        title: f.resource.title,
        before: fmt(subs),
        after: next === null ? "(field deleted)" : fmt(next),
      });
    }
  }

  return { hits, matched, changing, capped };
}

export type ApplyResult = { ok: boolean; changed: number; message: string };

/** Apply the run, writing the change log first. */
export async function applyChange(spec: ChangeSpec, runBy: string): Promise<ApplyResult> {
  const preview = await previewChange(spec, 25);
  if (preview.error) return { ok: false, changed: 0, message: preview.error };
  if (preview.changing === 0)
    return { ok: false, changed: 0, message: "Nothing matches, so nothing was changed." };

  // The log goes in before the edit: it is the only record of what the values
  // used to be.
  await prisma.marcChangeLog.create({
    data: {
      operation: spec.operation,
      tag: spec.tag,
      subfieldCode: spec.subfieldCode || null,
      findText: spec.findText || null,
      replaceText: spec.replaceText || null,
      matched: preview.matched,
      changed: preview.changing,
      runBy,
      sample: preview.hits.slice(0, 25),
    },
  });

  const candidates = await prisma.marcField.findMany({
    where: { tag: spec.tag },
    orderBy: { updatedAt: "asc" },
    take: GLOBAL_CHANGE_CAP,
  });

  let changed = 0;
  const toDelete: string[] = [];
  for (const f of candidates) {
    const subs = parseSubfields(f.subfields);
    const { subs: next, changed: didChange } = applyToField(subs, spec);
    if (!didChange) continue;
    if (next === null) toDelete.push(f.id);
    else await prisma.marcField.update({ where: { id: f.id }, data: { subfields: next } });
    changed++;
  }
  if (toDelete.length > 0) {
    await prisma.marcField.deleteMany({ where: { id: { in: toDelete } } });
  }

  const verb =
    spec.operation === "DELETE_FIELD" ? "deleted"
    : spec.operation === "ADD_SUBFIELD" ? "extended"
    : "rewritten";
  return {
    ok: true,
    changed,
    message: `${changed} field${changed === 1 ? "" : "s"} ${verb}${preview.capped ? ` (capped at ${GLOBAL_CHANGE_CAP} per run, so run it again to continue)` : ""}.`,
  };
}
