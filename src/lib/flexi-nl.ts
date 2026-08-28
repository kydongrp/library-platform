/**
 * Natural-language report requests, mapped onto the FlexiReports cube engine.
 *
 * The model never writes a query. It chooses from an enumerated vocabulary that
 * is generated from the live CUBES array, and everything it returns is
 * validated again here against that same array. So the worst a wrong answer can
 * do is build a report the admin can see is wrong and correct with the ordinary
 * dropdowns; it cannot reach a table, a column or a row the cube engine does
 * not already expose.
 *
 * Two deliberate choices worth knowing about:
 *
 * 1. Text-to-SQL was rejected. A model writing SQL against this database would
 *    be a new arbitrary query surface over member and staff personal data in a
 *    government system, and a plausible-but-wrong aggregation is invisible to
 *    the person reading the result. Constraining the model to a governed
 *    semantic layer is what Looker, Power BI Q&A and Tableau's Ask Data do, for
 *    the same reason.
 *
 * 2. The model does NOT compute dates. It names a period ("last_quarter") and
 *    resolveNamedPeriod turns that into day keys in the library's timezone.
 *    Asking a language model to do calendar arithmetic is asking for an
 *    off-by-one that nobody notices, and quarter boundaries in Asia/Singapore
 *    are not the same instants as in UTC.
 *
 * Everything in this module is pure: no network, no database, no env. The API
 * call lives in src/lib/flexi-ai.ts.
 */
import { CUBES, getCube } from "@/lib/flexi";
import { VIEWS, VIEWS_NEEDING_COLUMNS } from "@/lib/flexi-core";
import { zonedDayKey } from "@/lib/tz";

/** Longest request we will send. Long enough for a real question. */
export const PROMPT_MAX = 400;

/* ---------- Named periods ---------- */

/**
 * The periods the model may name. Resolved here, in the library's timezone,
 * rather than by the model.
 *
 * "custom" is the escape hatch for a request that names explicit dates; the
 * model then supplies from/to and they are validated as day keys.
 */
export const NAMED_PERIODS = [
  "all_time",
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
  "year_to_date",
  "custom",
] as const;

export type NamedPeriod = (typeof NAMED_PERIODS)[number];

export const PERIOD_LABELS: Record<NamedPeriod, string> = {
  all_time: "All time",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  last_90_days: "Last 90 days",
  this_month: "This month",
  last_month: "Last month",
  this_quarter: "This quarter",
  last_quarter: "Last quarter",
  this_year: "This year",
  last_year: "Last year",
  year_to_date: "Year to date",
  custom: "Custom range",
};

const DAY_MS = 86_400_000;

/** Split a "YYYY-MM-DD" day key into numbers. */
function partsOf(key: string): { y: number; m: number; d: number } {
  const [y, m, d] = key.split("-").map(Number);
  return { y, m, d };
}

function dayKey(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Last calendar day of a month, 1-indexed month. */
function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Turn a named period into inclusive from/to day keys.
 *
 * Both bounds are day keys in the library's timezone, which is exactly what the
 * flexi page's parseRange expects: it hands them to zonedDayRange, so "to" is
 * inclusive of the whole named day. all_time returns nulls, which parseRange
 * reads as no range at all.
 *
 * Rolling windows END TODAY and are inclusive of it, so "last 7 days" is today
 * plus the six days before. That is what someone asking for the last 7 days
 * means, and excluding today would quietly omit everything that happened this
 * morning.
 */
export function resolveNamedPeriod(
  period: NamedPeriod,
  now: Date,
): { from: string | null; to: string | null } {
  const today = zonedDayKey(now);
  const { y, m } = partsOf(today);

  const rolling = (days: number) => ({
    // days - 1 because the window includes today.
    from: zonedDayKey(new Date(now.getTime() - (days - 1) * DAY_MS)),
    to: today,
  });

  switch (period) {
    case "all_time":
      return { from: null, to: null };
    case "last_7_days":
      return rolling(7);
    case "last_30_days":
      return rolling(30);
    case "last_90_days":
      return rolling(90);
    case "this_month":
      return { from: dayKey(y, m, 1), to: today };
    case "last_month": {
      const ly = m === 1 ? y - 1 : y;
      const lm = m === 1 ? 12 : m - 1;
      return { from: dayKey(ly, lm, 1), to: dayKey(ly, lm, lastDayOfMonth(ly, lm)) };
    }
    case "this_quarter": {
      const qStart = Math.floor((m - 1) / 3) * 3 + 1;
      return { from: dayKey(y, qStart, 1), to: today };
    }
    case "last_quarter": {
      const thisQStart = Math.floor((m - 1) / 3) * 3 + 1;
      const ly = thisQStart === 1 ? y - 1 : y;
      const lqStart = thisQStart === 1 ? 10 : thisQStart - 3;
      const lqEnd = lqStart + 2;
      return { from: dayKey(ly, lqStart, 1), to: dayKey(ly, lqEnd, lastDayOfMonth(ly, lqEnd)) };
    }
    case "this_year":
      // The whole calendar year, so a report can include months still to come
      // and show them empty rather than looking truncated.
      return { from: dayKey(y, 1, 1), to: dayKey(y, 12, 31) };
    case "last_year":
      return { from: dayKey(y - 1, 1, 1), to: dayKey(y - 1, 12, 31) };
    case "year_to_date":
      return { from: dayKey(y, 1, 1), to: today };
    case "custom":
      // The caller supplies the dates; nothing to resolve.
      return { from: null, to: null };
  }
}

/** A day key the flexi page will accept: YYYY-MM-DD and a real calendar date. */
export function isDayKey(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const { y, m, d } = partsOf(v);
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= lastDayOfMonth(y, m);
}

/* ---------- The vocabulary handed to the model ---------- */

/**
 * The cube vocabulary as compact text for the prompt.
 *
 * Generated from CUBES at call time, never hand-copied: a cube or dimension
 * added to flexi.ts must appear here automatically, or the model would be
 * choosing from a stale menu and the mismatch would only show as a validation
 * failure the user cannot act on.
 */
export function catalogueForPrompt(): string {
  return CUBES.map((c) => {
    const dims = c.dimensions.map((d) => `${d.key}${d.temporal ? " (time)" : ""}`).join(", ");
    const measures = c.measures.map((m) => `${m.key} [${m.kind}${m.format === "money" ? ", money" : ""}]`).join(", ");
    return [
      `CUBE ${c.key} - ${c.name}`,
      `  what it counts: ${c.unit}; dates filter on ${c.dateLabel}`,
      `  ${c.description}`,
      `  dimensions: ${dims}`,
      `  measures: ${measures}`,
    ].join("\n");
  }).join("\n\n");
}

/** Every dimension key across all cubes, for the response schema's enum. */
export function allDimensionKeys(): string[] {
  return [...new Set(CUBES.flatMap((c) => c.dimensions.map((d) => d.key)))].sort();
}

/** Every measure key across all cubes, for the response schema's enum. */
export function allMeasureKeys(): string[] {
  return [...new Set(CUBES.flatMap((c) => c.measures.map((m) => m.key)))].sort();
}

/**
 * JSON schema for the model's reply.
 *
 * The enums are a union across cubes, because a per-cube oneOf would express
 * cube membership at the schema level but is a far more fragile schema. Cube
 * membership is enforced in validateNlSpec instead, which is the check that
 * actually has to be right and is unit tested.
 */
export function specJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      ok: {
        type: "boolean",
        description:
          "true if the request can be answered from one of the cubes; false if it cannot.",
      },
      reason: {
        type: ["string", "null"],
        description:
          "When ok is false: one sentence, addressed to a librarian, saying what is missing and what they could ask instead. Null when ok is true.",
      },
      reading: {
        type: ["string", "null"],
        description:
          "When ok is true: one short sentence restating the question you are answering, so the librarian can see whether you understood it. Null when ok is false.",
      },
      cube: { type: ["string", "null"], enum: [...CUBES.map((c) => c.key), null] },
      row: { type: ["string", "null"], enum: [...allDimensionKeys(), null] },
      col: {
        type: ["string", "null"],
        enum: [...allDimensionKeys(), null],
        description: "A second dimension to break the rows down by, or null for none.",
      },
      measure: { type: ["string", "null"], enum: [...allMeasureKeys(), null] },
      period: { type: ["string", "null"], enum: [...NAMED_PERIODS, null] },
      from: {
        type: ["string", "null"],
        description: 'Only when period is "custom": inclusive start date as YYYY-MM-DD.',
      },
      to: {
        type: ["string", "null"],
        description: 'Only when period is "custom": inclusive end date as YYYY-MM-DD.',
      },
      view: { type: ["string", "null"], enum: [...VIEWS.map((v) => v.key), null] },
    },
    required: ["ok", "reason", "reading", "cube", "row", "col", "measure", "period", "from", "to", "view"],
    additionalProperties: false,
  };
}

/* ---------- Validation ---------- */

export type FlexiSpec = {
  cube: string;
  row: string;
  col: string | null;
  measure: string;
  period: NamedPeriod;
  from: string | null;
  to: string | null;
  view: string;
  reading: string;
};

export type NlResult =
  | { ok: true; spec: FlexiSpec }
  | { ok: false; reason: string; kind: "refused" | "invalid" };

/**
 * Validate the model's reply against the live cube definitions.
 *
 * Rejects rather than repairs. A silently corrected spec is a report the admin
 * did not ask for, presented as though they had, and that is worse than being
 * told the request could not be turned into a report.
 *
 * The one exception is deliberate and visible: a chart view that needs a column
 * dimension is downgraded to a bar chart when there is no column dimension,
 * because the flexi page already does exactly that (page.tsx) and disagreeing
 * with it would make the reading text describe something the page will not
 * render.
 */
export function validateNlSpec(raw: unknown, now: Date): NlResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "The assistant returned nothing usable.", kind: "invalid" };
  }
  const r = raw as Record<string, unknown>;

  if (r.ok === false) {
    const reason =
      typeof r.reason === "string" && r.reason.trim()
        ? r.reason.trim()
        : "That question cannot be answered from the available report data.";
    return { ok: false, reason, kind: "refused" };
  }

  const cube = typeof r.cube === "string" ? getCube(r.cube) : undefined;
  if (!cube) {
    return { ok: false, reason: "The assistant picked a report area that does not exist.", kind: "invalid" };
  }

  const row = cube.dimensions.find((d) => d.key === r.row);
  if (!row) {
    return {
      ok: false,
      reason: `The assistant asked to group by something ${cube.name} does not have.`,
      kind: "invalid",
    };
  }

  // null and "" and "none" all mean "no column dimension".
  const wantsCol = typeof r.col === "string" && r.col !== "" && r.col !== "none";
  const col = wantsCol ? cube.dimensions.find((d) => d.key === r.col) : null;
  if (wantsCol && !col) {
    return {
      ok: false,
      reason: `The assistant asked to break down by something ${cube.name} does not have.`,
      kind: "invalid",
    };
  }
  if (col && col.key === row.key) {
    return {
      ok: false,
      reason: "The assistant used the same field for both rows and columns, which produces nothing useful.",
      kind: "invalid",
    };
  }

  const measure = cube.measures.find((m) => m.key === r.measure);
  if (!measure) {
    return {
      ok: false,
      reason: `The assistant picked a figure ${cube.name} cannot compute.`,
      kind: "invalid",
    };
  }

  const period: NamedPeriod = (NAMED_PERIODS as readonly string[]).includes(String(r.period))
    ? (r.period as NamedPeriod)
    : "all_time";

  let from: string | null;
  let to: string | null;
  if (period === "custom") {
    // A bound that is PRESENT but malformed is rejected, not dropped. Dropping
    // it would widen the range to the beginning of time while the reading text
    // still described a bounded period, so the description would lie about the
    // figures underneath it. An ABSENT bound is fine and means open-ended.
    const given = (v: unknown) => v !== null && v !== undefined && v !== "";
    if (given(r.from) && !isDayKey(r.from)) {
      return {
        ok: false,
        reason: "The assistant gave a start date that is not a real calendar date.",
        kind: "invalid",
      };
    }
    if (given(r.to) && !isDayKey(r.to)) {
      return {
        ok: false,
        reason: "The assistant gave an end date that is not a real calendar date.",
        kind: "invalid",
      };
    }
    from = given(r.from) ? (r.from as string) : null;
    to = given(r.to) ? (r.to as string) : null;
    if (!from && !to) {
      return {
        ok: false,
        reason: "The assistant asked for a custom date range but did not give any dates.",
        kind: "invalid",
      };
    }
    // A backwards range would return nothing and look like missing data.
    if (from && to && from > to) [from, to] = [to, from];
  } else {
    ({ from, to } = resolveNamedPeriod(period, now));
  }

  let view = VIEWS.some((v) => v.key === r.view) ? String(r.view) : "table";
  if (!col && VIEWS_NEEDING_COLUMNS.includes(view)) view = "bar";

  const reading =
    typeof r.reading === "string" && r.reading.trim()
      ? r.reading.trim().slice(0, 300)
      : describeSpecPlainly({ cube: cube.key, row: row.key, col: col?.key ?? null, measure: measure.key });

  return {
    ok: true,
    spec: { cube: cube.key, row: row.key, col: col?.key ?? null, measure: measure.key, period, from, to, view, reading },
  };
}

/* ---------- Rendering the spec back out ---------- */

/**
 * The spec as a query string for the existing flexi page.
 *
 * Nothing new renders the report: this is a link into the page that already
 * pivots, caps, charts and exports.
 */
export function specToQuery(spec: FlexiSpec): string {
  const q = new URLSearchParams();
  q.set("cube", spec.cube);
  q.set("rows", spec.row);
  if (spec.col) q.set("cols", spec.col);
  q.set("measure", spec.measure);
  q.set("view", spec.view);
  if (spec.from) q.set("from", spec.from);
  if (spec.to) q.set("to", spec.to);
  return q.toString();
}

/** Human labels, used when the model gave no reading of its own. */
function describeSpecPlainly(s: { cube: string; row: string; col: string | null; measure: string }): string {
  const cube = getCube(s.cube);
  const rowLabel = cube?.dimensions.find((d) => d.key === s.row)?.label ?? s.row;
  const colLabel = s.col ? (cube?.dimensions.find((d) => d.key === s.col)?.label ?? s.col) : null;
  const measureLabel = cube?.measures.find((m) => m.key === s.measure)?.label ?? s.measure;
  return colLabel
    ? `${measureLabel} by ${rowLabel}, broken down by ${colLabel}.`
    : `${measureLabel} by ${rowLabel}.`;
}

/**
 * The spec in words, for the confirmation strip above the result.
 *
 * Every field is named, because the whole safeguard is that a librarian can
 * read this and tell that the question they asked is not the question being
 * answered.
 */
export function describeSpec(spec: FlexiSpec): {
  cube: string;
  rows: string;
  columns: string;
  measure: string;
  period: string;
  view: string;
} {
  const cube = getCube(spec.cube);
  const dim = (k: string | null) =>
    k ? (cube?.dimensions.find((d) => d.key === k)?.label ?? k) : "None";
  const periodText =
    spec.period === "custom" || spec.period === "all_time"
      ? spec.from || spec.to
        ? `${spec.from ?? "the beginning"} to ${spec.to ?? "today"}`
        : "All time"
      : `${PERIOD_LABELS[spec.period]}${spec.from && spec.to ? ` (${spec.from} to ${spec.to})` : ""}`;
  return {
    cube: cube?.name ?? spec.cube,
    rows: dim(spec.row),
    columns: dim(spec.col),
    measure: cube?.measures.find((m) => m.key === spec.measure)?.label ?? spec.measure,
    period: `${periodText}, on ${cube?.dateLabel ?? "date"}`,
    view: VIEWS.find((v) => v.key === spec.view)?.label ?? spec.view,
  };
}
