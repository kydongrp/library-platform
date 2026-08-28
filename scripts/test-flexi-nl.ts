/**
 * Natural-language report requests: date resolution and spec validation.
 *
 *   npx tsx scripts/test-flexi-nl.ts
 *
 * Pure: no network, no model, no database. Two things are being protected.
 *
 * First, the calendar. The model names a period and this code resolves it,
 * precisely so nobody depends on a language model doing month arithmetic. That
 * only helps if the arithmetic here is right at the boundaries: year rollovers,
 * quarter edges, and February in a leap year.
 *
 * Second, validation. The model may only name real cubes, dimensions and
 * measures, and a spec that does not check out must be REJECTED rather than
 * repaired. A silently corrected spec is a report the librarian did not ask
 * for, presented as though they had.
 */
import {
  resolveNamedPeriod,
  isDayKey,
  validateNlSpec,
  specToQuery,
  describeSpec,
  catalogueForPrompt,
  specJsonSchema,
  allDimensionKeys,
  allMeasureKeys,
  NAMED_PERIODS,
  PERIOD_LABELS,
  type NamedPeriod,
} from "../src/lib/flexi-nl";
import { CUBES } from "../src/lib/flexi";
import { VIEWS } from "../src/lib/flexi-core";

let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}

/** A fixed instant, expressed in UTC, so every assertion is deterministic. */
const at = (iso: string) => new Date(iso);

const range = (p: NamedPeriod, iso: string) => {
  const r = resolveNamedPeriod(p, at(iso));
  return `${r.from ?? "-"}..${r.to ?? "-"}`;
};

console.log("Periods resolve in the library's timezone, not UTC:");
{
  // 17:00Z is already the next day in Asia/Singapore (UTC+8).
  check(
    "a late-evening UTC instant is already tomorrow in Singapore",
    range("year_to_date", "2026-08-28T17:00:00Z") === "2026-01-01..2026-08-29",
    range("year_to_date", "2026-08-28T17:00:00Z"),
  );
  check(
    "the same instant an hour earlier is still today",
    range("year_to_date", "2026-08-28T15:00:00Z") === "2026-01-01..2026-08-28",
    range("year_to_date", "2026-08-28T15:00:00Z"),
  );
  // Month boundary: 2026-07-31T16:00Z is 2026-08-01 08:00 in Singapore.
  check(
    "a month boundary is judged in Singapore",
    range("this_month", "2026-07-31T16:00:00Z") === "2026-08-01..2026-08-01",
    range("this_month", "2026-07-31T16:00:00Z"),
  );
}

console.log("\nCalendar periods, mid-year:");
{
  const NOW = "2026-08-28T04:00:00Z"; // 2026-08-28 noon in Singapore
  check("all_time has no bounds", range("all_time", NOW) === "-..-");
  check("this_month", range("this_month", NOW) === "2026-08-01..2026-08-28", range("this_month", NOW));
  check("last_month", range("last_month", NOW) === "2026-07-01..2026-07-31", range("last_month", NOW));
  check("this_quarter is Q3", range("this_quarter", NOW) === "2026-07-01..2026-08-28", range("this_quarter", NOW));
  check("last_quarter is Q2", range("last_quarter", NOW) === "2026-04-01..2026-06-30", range("last_quarter", NOW));
  check("this_year is the whole year", range("this_year", NOW) === "2026-01-01..2026-12-31", range("this_year", NOW));
  check("last_year", range("last_year", NOW) === "2025-01-01..2025-12-31", range("last_year", NOW));
  check("year_to_date stops today", range("year_to_date", NOW) === "2026-01-01..2026-08-28", range("year_to_date", NOW));
}

console.log("\nRolling windows include today:");
{
  const NOW = "2026-08-28T04:00:00Z";
  // 7 days ending today inclusive = today plus the six before it.
  check("last_7_days", range("last_7_days", NOW) === "2026-08-22..2026-08-28", range("last_7_days", NOW));
  check("last_30_days", range("last_30_days", NOW) === "2026-07-30..2026-08-28", range("last_30_days", NOW));
  check("last_90_days", range("last_90_days", NOW) === "2026-05-31..2026-08-28", range("last_90_days", NOW));
  // Excluding today would quietly omit this morning's activity.
  check("a rolling window ends today, not yesterday", resolveNamedPeriod("last_7_days", at(NOW)).to === "2026-08-28");
}

console.log("\nYear rollovers:");
{
  const JAN = "2026-01-15T04:00:00Z";
  check("last_month crosses into the previous year", range("last_month", JAN) === "2025-12-01..2025-12-31", range("last_month", JAN));
  check("this_quarter is Q1", range("this_quarter", JAN) === "2026-01-01..2026-01-15", range("this_quarter", JAN));
  check("last_quarter is Q4 of the previous year", range("last_quarter", JAN) === "2025-10-01..2025-12-31", range("last_quarter", JAN));
  check("last_year", range("last_year", JAN) === "2025-01-01..2025-12-31");
  // 1 January itself.
  const NY = "2026-01-01T04:00:00Z";
  check("on 1 January, this_month is a single day", range("this_month", NY) === "2026-01-01..2026-01-01", range("this_month", NY));
  check("on 1 January, ytd is a single day", range("year_to_date", NY) === "2026-01-01..2026-01-01");
  check("on 1 January, last_7_days reaches back into December", range("last_7_days", NY) === "2025-12-26..2026-01-01", range("last_7_days", NY));
}

console.log("\nEvery quarter edge:");
{
  const cases: [string, string, string][] = [
    ["2026-01-01T04:00:00Z", "2026-01-01..2026-01-01", "2025-10-01..2025-12-31"],
    ["2026-03-31T04:00:00Z", "2026-01-01..2026-03-31", "2025-10-01..2025-12-31"],
    ["2026-04-01T04:00:00Z", "2026-04-01..2026-04-01", "2026-01-01..2026-03-31"],
    ["2026-06-30T04:00:00Z", "2026-04-01..2026-06-30", "2026-01-01..2026-03-31"],
    ["2026-07-01T04:00:00Z", "2026-07-01..2026-07-01", "2026-04-01..2026-06-30"],
    ["2026-09-30T04:00:00Z", "2026-07-01..2026-09-30", "2026-04-01..2026-06-30"],
    ["2026-10-01T04:00:00Z", "2026-10-01..2026-10-01", "2026-07-01..2026-09-30"],
    ["2026-12-31T04:00:00Z", "2026-10-01..2026-12-31", "2026-07-01..2026-09-30"],
  ];
  for (const [now, thisQ, lastQ] of cases) {
    const d = now.slice(0, 10);
    check(`${d}: this_quarter`, range("this_quarter", now) === thisQ, range("this_quarter", now));
    check(`${d}: last_quarter`, range("last_quarter", now) === lastQ, range("last_quarter", now));
  }
}

console.log("\nMonth lengths, including February:");
{
  check("last_month in March of a leap year is 29 days", range("last_month", "2024-03-05T04:00:00Z") === "2024-02-01..2024-02-29", range("last_month", "2024-03-05T04:00:00Z"));
  check("last_month in March of a common year is 28 days", range("last_month", "2023-03-05T04:00:00Z") === "2023-02-01..2023-02-28", range("last_month", "2023-03-05T04:00:00Z"));
  check("last_month in 2100 (not a leap year) is 28 days", range("last_month", "2100-03-05T04:00:00Z") === "2100-02-01..2100-02-28", range("last_month", "2100-03-05T04:00:00Z"));
  check("last_month after a 31-day month", range("last_month", "2026-09-05T04:00:00Z") === "2026-08-01..2026-08-31");
  check("last_month after a 30-day month", range("last_month", "2026-05-05T04:00:00Z") === "2026-04-01..2026-04-30");
  check("on the 31st, this_month ends on the 31st", range("this_month", "2026-08-31T04:00:00Z") === "2026-08-01..2026-08-31");
}

console.log("\nEvery named period resolves without throwing:");
{
  for (const p of NAMED_PERIODS) {
    let ok = true;
    try {
      resolveNamedPeriod(p, at("2026-08-28T04:00:00Z"));
    } catch {
      ok = false;
    }
    check(`${p} resolves`, ok);
    check(`${p} has a label`, typeof PERIOD_LABELS[p] === "string" && PERIOD_LABELS[p].length > 0);
  }
  // from must never be after to.
  for (const p of NAMED_PERIODS) {
    const r = resolveNamedPeriod(p, at("2026-08-28T04:00:00Z"));
    check(`${p} is not backwards`, !r.from || !r.to || r.from <= r.to, `${r.from}..${r.to}`);
  }
}

console.log("\nDay keys are validated as real calendar dates:");
{
  check("a normal date", isDayKey("2026-08-28"));
  check("29 Feb in a leap year", isDayKey("2024-02-29"));
  check("29 Feb in a common year is refused", !isDayKey("2023-02-29"));
  check("31 April is refused", !isDayKey("2026-04-31"));
  check("month 13 is refused", !isDayKey("2026-13-01"));
  check("month 00 is refused", !isDayKey("2026-00-05"));
  check("day 00 is refused", !isDayKey("2026-08-00"));
  check("a slashed date is refused", !isDayKey("2026/08/28"));
  check("a short year is refused", !isDayKey("26-08-28"));
  check("a timestamp is refused", !isDayKey("2026-08-28T00:00:00Z"));
  check("empty is refused", !isDayKey(""));
  check("a number is refused", !isDayKey(20260828));
  check("null is refused", !isDayKey(null));
  check("sql is refused", !isDayKey("2026-08-28; DROP TABLE"));
}

console.log("\nA good spec validates:");
{
  const NOW = at("2026-08-28T04:00:00Z");
  const r = validateNlSpec(
    {
      ok: true,
      reason: null,
      reading: "Loans each month, split by member type, for the first half of 2026.",
      cube: "circulation",
      row: "borrowedMonth",
      col: "memberType",
      measure: "loans",
      period: "custom",
      from: "2026-01-01",
      to: "2026-06-30",
      view: "stacked",
    },
    NOW,
  );
  check("it is accepted", r.ok, r.ok ? "" : r.reason);
  if (r.ok) {
    check("cube kept", r.spec.cube === "circulation");
    check("row kept", r.spec.row === "borrowedMonth");
    check("col kept", r.spec.col === "memberType");
    check("measure kept", r.spec.measure === "loans");
    check("custom dates kept", r.spec.from === "2026-01-01" && r.spec.to === "2026-06-30");
    check("stacked view kept when there is a column", r.spec.view === "stacked");
    check("the model's reading is kept", r.spec.reading.startsWith("Loans each month"));

    const qs = specToQuery(r.spec);
    check("query names the cube", qs.includes("cube=circulation"));
    check("query uses rows=, the page's parameter name", qs.includes("rows=borrowedMonth"));
    check("query uses cols=, the page's parameter name", qs.includes("cols=memberType"));
    check("query carries the measure", qs.includes("measure=loans"));
    check("query carries the dates", qs.includes("from=2026-01-01") && qs.includes("to=2026-06-30"));

    const d = describeSpec(r.spec);
    check("description names the cube in words", d.cube === "Circulation Analysis", d.cube);
    check("description names the period and what dates mean", d.period.includes("borrow date"), d.period);
  }
}

console.log("\nA named period is resolved, not passed through:");
{
  const r = validateNlSpec(
    { ok: true, reason: null, reading: null, cube: "circulation", row: "borrowedMonth",
      col: null, measure: "loans", period: "last_quarter", from: null, to: null, view: "table" },
    at("2026-08-28T04:00:00Z"),
  );
  check("accepted", r.ok);
  if (r.ok) {
    check("dates come from the named period", r.spec.from === "2026-04-01" && r.spec.to === "2026-06-30", `${r.spec.from}..${r.spec.to}`);
    check("a missing reading is filled in", r.spec.reading.length > 0, r.spec.reading);
    check("no column means no cols= parameter", !specToQuery(r.spec).includes("cols="));
  }
}

console.log("\nRefusal is passed through as a refusal, not an error:");
{
  const r = validateNlSpec(
    { ok: false, reason: "There is no data on which staff member shelved an item.", reading: null,
      cube: null, row: null, col: null, measure: null, period: null, from: null, to: null, view: null },
    at("2026-08-28T04:00:00Z"),
  );
  check("not ok", !r.ok);
  if (!r.ok) {
    check("kind is refused, not invalid", r.kind === "refused", r.kind);
    check("the model's reason is shown to the user", r.reason.includes("no data on which staff member"));
  }
  const bare = validateNlSpec({ ok: false, reason: "", reading: null, cube: null, row: null, col: null, measure: null, period: null, from: null, to: null, view: null }, at("2026-08-28T04:00:00Z"));
  check("an empty reason still yields a sentence", !bare.ok && bare.reason.length > 10);
}

console.log("\nEvery invalid spec is rejected, never repaired:");
{
  const NOW = at("2026-08-28T04:00:00Z");
  const base = {
    ok: true, reason: null, reading: null, cube: "circulation", row: "borrowedMonth",
    col: null, measure: "loans", period: "all_time", from: null, to: null, view: "table",
  };
  const bad = (patch: Record<string, unknown>, label: string) => {
    const r = validateNlSpec({ ...base, ...patch }, NOW);
    check(label, !r.ok && r.kind === "invalid", r.ok ? "ACCEPTED" : `kind=${r.kind}`);
  };

  bad({ cube: "nonexistent" }, "an unknown cube");
  bad({ cube: null }, "a null cube");
  bad({ cube: 42 }, "a numeric cube");
  // memberType is a real dimension, but of the circulation and members cubes.
  bad({ cube: "acquisitions", row: "memberType" }, "a dimension from a different cube");
  bad({ row: "notADimension" }, "an unknown dimension");
  bad({ row: null }, "a null row dimension");
  bad({ measure: "value" }, "a measure from a different cube (value is acquisitions)");
  bad({ measure: "notAMeasure" }, "an unknown measure");
  bad({ measure: null }, "a null measure");
  bad({ col: "notADimension" }, "an unknown column dimension");
  bad({ col: "fund" }, "a column dimension from a different cube");
  bad({ row: "memberType", col: "memberType" }, "the same field for rows and columns");
  bad({ period: "custom", from: null, to: null }, "custom with no dates");
  bad({ period: "custom", from: "not-a-date", to: "also-not" }, "custom with unparseable dates");
  bad({ period: "custom", from: "2026-02-30", to: "2026-03-01" }, "custom with an impossible date");

  for (const junk of [null, undefined, "a string", 42, []]) {
    const r = validateNlSpec(junk, NOW);
    check(`${JSON.stringify(junk) ?? "undefined"} is rejected without throwing`, !r.ok);
  }
}

console.log("\nTolerated, because the page behaves the same way:");
{
  const NOW = at("2026-08-28T04:00:00Z");
  const base = {
    ok: true, reason: null, reading: null, cube: "circulation", row: "borrowedMonth",
    col: null, measure: "loans", period: "all_time", from: null, to: null, view: "table",
  };
  // The flexi page downgrades a stacked/column view when there is no column
  // dimension, so the validator must agree or the description would promise a
  // chart the page will not draw.
  for (const v of ["stacked", "columns"]) {
    const r = validateNlSpec({ ...base, view: v }, NOW);
    check(`${v} without a column dimension becomes a bar chart`, r.ok && r.spec.view === "bar", r.ok ? r.spec.view : "rejected");
  }
  const unknownView = validateNlSpec({ ...base, view: "sankey" }, NOW);
  check("an unknown view falls back to the table", unknownView.ok && unknownView.spec.view === "table");
  const noneCol = validateNlSpec({ ...base, col: "none" }, NOW);
  check('col "none" is read as no column', noneCol.ok && noneCol.spec.col === null);
  const emptyCol = validateNlSpec({ ...base, col: "" }, NOW);
  check('col "" is read as no column', emptyCol.ok && emptyCol.spec.col === null);
  const badPeriod = validateNlSpec({ ...base, period: "since_forever" }, NOW);
  check("an unknown period falls back to all time", badPeriod.ok && badPeriod.spec.period === "all_time");
  const backwards = validateNlSpec({ ...base, period: "custom", from: "2026-06-30", to: "2026-01-01" }, NOW);
  check("a backwards custom range is swapped, not left to return nothing", backwards.ok && backwards.spec.from === "2026-01-01" && backwards.spec.to === "2026-06-30");
  const oneBound = validateNlSpec({ ...base, period: "custom", from: "2026-01-01", to: null }, NOW);
  check("custom with only a start date is allowed", oneBound.ok && oneBound.spec.from === "2026-01-01" && oneBound.spec.to === null);
}

console.log("\nThe vocabulary is generated from the live cubes, never hand-copied:");
{
  const cat = catalogueForPrompt();
  for (const c of CUBES) {
    check(`catalogue lists cube ${c.key}`, cat.includes(`CUBE ${c.key}`));
    check(`catalogue lists ${c.key}'s date meaning`, cat.includes(c.dateLabel));
    for (const d of c.dimensions) {
      check(`catalogue lists ${c.key}.${d.key}`, cat.includes(d.key));
    }
    for (const m of c.measures) {
      check(`catalogue lists measure ${c.key}.${m.key}`, cat.includes(m.key));
    }
  }

  const schema = specJsonSchema() as {
    properties: Record<string, { enum?: unknown[] }>;
    required: string[];
  };
  const cubeEnum = schema.properties.cube.enum ?? [];
  check("the cube enum matches CUBES exactly", CUBES.every((c) => cubeEnum.includes(c.key)) && cubeEnum.length === CUBES.length + 1, JSON.stringify(cubeEnum));
  const rowEnum = schema.properties.row.enum ?? [];
  check("every dimension key is offered", allDimensionKeys().every((k) => rowEnum.includes(k)));
  const measureEnum = schema.properties.measure.enum ?? [];
  check("every measure key is offered", allMeasureKeys().every((k) => measureEnum.includes(k)));
  const viewEnum = schema.properties.view.enum ?? [];
  check("every view is offered", VIEWS.every((v) => viewEnum.includes(v.key)));
  const periodEnum = schema.properties.period.enum ?? [];
  check("every named period is offered", NAMED_PERIODS.every((p) => periodEnum.includes(p)));
  check("all fields are required, so the model cannot omit one", schema.required.length === Object.keys(schema.properties).length);

  // Guard against a stale enum: nothing may be offered that no cube has.
  const realDims = new Set(allDimensionKeys());
  check("no phantom dimension is offered", rowEnum.every((k) => k === null || realDims.has(k as string)));
  const realMeasures = new Set(allMeasureKeys());
  check("no phantom measure is offered", measureEnum.every((k) => k === null || realMeasures.has(k as string)));
}

console.log(
  failures === 0
    ? "\nCLEAN: dates resolve correctly in Asia/Singapore across quarter, year and leap-February boundaries, and a spec naming anything the cubes do not have is rejected rather than repaired."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
