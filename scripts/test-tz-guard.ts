/**
 * Guard against the timezone defect coming back.
 *
 *   npx tsx scripts/test-tz-guard.ts
 *
 * The behavioural suites prove today's code is right. This one proves tomorrow's
 * edit cannot quietly reintroduce the same class of bug, by scanning the source
 * for the four patterns that caused it:
 *
 *   1. server-local day boundaries      setHours(0,0,0,0), getDay(), getHours()
 *   2. UTC calendar parts on an instant getUTCDay/getUTCDate/getUTCMonth/...
 *   3. formatting with no timeZone      toLocaleDateString / toLocaleTimeString
 *   4. UTC day strings                  toISOString().slice(0, 10)
 *
 * It is a scanner, not a parser: it works on lines with strings and comments
 * blanked out. That is enough to keep an idiom out of the vocabulary, and it is
 * why an exemption has to be written down rather than inferred.
 *
 * Exemptions are inline, at the site, with a reason:
 *
 *   return stamp(d); // tz-guard-allow: 005 is a machine version stamp
 *
 * They used to be per-file, and that hid a real bug: src/lib/marc.ts was
 * exempted so marc005 could stamp in UTC, and the exemption silently covered
 * the 008 builder twelve lines above it, which took its year and month from
 * Singapore and its day-of-month from UTC and exported dates like 31 September.
 * A file-wide exemption is a blanket over everything anyone adds to that file
 * later; a line-scoped one is a claim about one line.
 *
 * A pragma that no longer sits on a matching line is itself a failure, so an
 * exemption cannot outlive the code it was written for.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname ?? ".", "..");

/**
 * Everything that runs, not just the app. prisma/seed.ts writes the holiday
 * calendar and scripts/ holds the operational tooling; a wrong day is as wrong
 * there as it is on a page, and seed.ts had exactly this bug.
 */
const ROOTS = ["src", "scripts", "prisma"];

/** An inline exemption. The reason is required, and is printed in the report. */
const ALLOW_PRAGMA = /tz-guard-allow:\s*(\S.*?)\s*$/;

const PATTERNS: { name: string; re: RegExp; note: string }[] = [
  {
    name: "server-local day boundary",
    // No lookbehinds. They used to read `(?<!getUTC)(?<![A-Za-z])` immediately
    // before the dot, so the character tested was the last character of the
    // RECEIVER: `someDate.getFullYear()` was unmatchable, because "e" is a
    // letter, and every ordinary variable name ends in one. The commonest form
    // of the bug was invisible; only `new Date().getFullYear()` was ever
    // caught. Neither lookbehind was needed: `.getUTCDate()` contains no
    // `.getDate(` substring, so the UTC spellings cannot match here anyway and
    // are caught by the pattern below.
    re: /\.setHours\s*\(|\.setMinutes\s*\(|\.setDate\s*\(|\.setMonth\s*\(|\.setFullYear\s*\(|\.getDay\s*\(\)|\.getHours\s*\(\)|\.getMinutes\s*\(\)|\.getSeconds\s*\(\)|\.getFullYear\s*\(\)|\.getMonth\s*\(\)|\.getDate\s*\(\)/,
    note: "reads the runtime's clock; use the helpers in src/lib/tz.ts",
  },
  {
    name: "UTC calendar part",
    re: /getUTC(?:Day|Date|Month|FullYear|Hours|Minutes|Seconds)\s*\(\)/,
    note: "the UTC day of an instant is yesterday for the first 8 hours of every Singapore day",
  },
  {
    name: "unzoned formatting",
    re: /toLocale(?:Date|Time)String\s*\(/,
    note: "resolves to the runtime zone; use formatDate / formatTime from src/lib/format.ts",
  },
  {
    name: "UTC day string",
    // Any slice of an ISO string, not only .slice(0, 10): a month bucket taken
    // as .slice(0, 7), or a .split("T")[0], is wrong in the same way and for
    // the same eight hours a day.
    re: /toISOString\s*\(\)\s*\.(?:slice|substring|substr|split)\s*\(/,
    note: "takes the UTC calendar day; use zonedDayKey from src/lib/tz.ts",
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "generated" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Blank out strings and comments so prose about the bug is not a hit.
 *
 * Strings go FIRST. The other order truncated any line holding a URL at the
 * "//" inside it, so a line reading
 * `const u = "https://x"; const y = d.getUTCFullYear();` was scanned as
 * `const u = "https:` and the violation after it was invisible.
 */
function code(text: string): string[] {
  return text.split("\n").map((line) => {
    // Only genuine comment openers. The old test was /^\s*[*\/]/, which blanked
    // any line starting with a slash, a regular expression literal included.
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) return "";
    return line
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      // Template literals only when they carry no ${...}. An interpolated one
      // holds real code: blanking those wholesale hid `${d.getUTCMonth()}`
      // inside an issue label, which is a genuine UTC read.
      .replace(/`(?:[^`\\$]|\\.|\$(?!\{))*`/g, "``")
      .replace(/\/\/.*$/, "");
  });
}

/**
 * Before scanning anything, check that the scanner can still see.
 *
 * This exists because the guard was silently blind for its whole life: a
 * lookbehind placed before the dot made `someDate.getFullYear()` unmatchable,
 * so it reported CLEAN while the commonest spelling of the bug sat in the tree.
 * A scanner that cannot fail is indistinguishable from one with nothing to
 * find, and this file is the only thing standing between the codebase and a
 * class of bug that shows up as a date being quietly one day out.
 */
const MUST_CATCH = [
  "  const y = someDate.getFullYear();",
  "  const m = d.getMonth() + 1;",
  "  const day = loan.dueAt.getDate();",
  "  const y = new Date().getFullYear();",
  "  const h = d.getHours();",
  "  d.setHours(0, 0, 0, 0);",
  "  const w = d.getDay();",
  "  const y = d.getUTCFullYear();",
  "  const bucket = d.toISOString().slice(0, 7);",
  "  const day = d.toISOString().split('T')[0];",
  '  const s = d.toLocaleDateString("en-GB");',
  // The two shapes code() used to lose entirely.
  '  const u = "https://example.org/x"; const y = d.getUTCFullYear();',
  "  const label = `entered ${d.getUTCMonth()}`;",
];

const MUST_IGNORE = [
  "  const t = d.getTime();",
  "  const k = zonedDayKey(d);",
  '  const s = d.toLocaleDateString("en-GB", { timeZone: LIBRARY_TZ });',
  "  const iso = d.toISOString();",
  "  // someDate.getFullYear() named in prose",
  "  * getUTCDate() named in a block comment",
];

let selfTestFailures = 0;
for (const line of MUST_CATCH) {
  const scanned = code(line)[0];
  const seen = PATTERNS.some(
    (p) => p.re.test(scanned) && !(p.name === "unzoned formatting" && /timeZone/.test(scanned)),
  );
  if (!seen) {
    selfTestFailures++;
    console.log(`  SCANNER BLIND: ${line.trim()}`);
  }
}
for (const line of MUST_IGNORE) {
  const scanned = code(line)[0];
  const seen = PATTERNS.some(
    (p) => p.re.test(scanned) && !(p.name === "unzoned formatting" && /timeZone/.test(scanned)),
  );
  if (seen) {
    selfTestFailures++;
    console.log(`  SCANNER OVER-EAGER: ${line.trim()}`);
  }
}
console.log(
  selfTestFailures === 0
    ? `Scanner self-test: ${MUST_CATCH.length} known-bad caught, ${MUST_IGNORE.length} known-good ignored.\n`
    : `Scanner self-test FAILED on ${selfTestFailures} case(s).\n`,
);

let violations = selfTestFailures;
const allowed: string[] = [];
const stalePragmas: string[] = [];

/**
 * The scanner does not scan itself. Its PATTERNS are these idioms written out
 * as data, and its own documentation has to be able to name the pragma without
 * thereby declaring one. No line in this file handles a real date.
 */
const SELF = join(ROOT, "scripts", "test-tz-guard.ts");

const files = ROOTS.flatMap((r) => walk(join(ROOT, r)))
  .filter((f) => f !== SELF)
  .sort();
console.log(
  `Scanning ${files.length} files under ${ROOTS.join(", ")} for the four patterns that caused the defect.\n`,
);

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const raw = readFileSync(file, "utf8").split("\n");
  const lines = code(raw.join("\n"));

  for (const [i, line] of lines.entries()) {
    const hits = PATTERNS.filter((p) => {
      if (!p.re.test(line)) return false;
      // An options object naming the zone is exactly what we want to see.
      if (p.name === "unzoned formatting" && /timeZone/.test(line)) return false;
      return true;
    });
    if (!hits.length) continue;

    // A pragma on the line itself, or on the line above it for a long line.
    const pragma = ALLOW_PRAGMA.exec(raw[i] ?? "") ?? ALLOW_PRAGMA.exec(raw[i - 1] ?? "");
    if (pragma) {
      allowed.push(`${rel}:${i + 1}  ${pragma[1]}`);
      continue;
    }

    for (const p of hits) {
      violations++;
      console.log(`  ${rel}:${i + 1}`);
      console.log(`    ${p.name}: ${line.trim().slice(0, 100)}`);
      console.log(`    ${p.note}`);
    }
  }

  // An exemption that no longer sits on a matching line is a claim about code
  // that has moved or gone. Left alone it quietly covers whatever lands there
  // next, which is how the marc.ts blanket came to hide a live bug.
  for (const [i, r] of raw.entries()) {
    if (!ALLOW_PRAGMA.test(r)) continue;
    const covers = [i, i + 1].some((j) => {
      const l = lines[j];
      return l !== undefined && PATTERNS.some((p) => p.re.test(l));
    });
    if (!covers) stalePragmas.push(`${rel}:${i + 1}`);
  }
}

if (allowed.length) {
  console.log("Allowed inline, with the reason given at the site:");
  for (const a of allowed) console.log(`  ${a}`);
}

if (stalePragmas.length) {
  console.log("\nExemptions that no longer sit on a matching line:");
  for (const s of stalePragmas) console.log(`  ${s}`);
  violations += stalePragmas.length;
}

console.log(
  violations === 0
    ? "\nCLEAN: no unzoned date handling outside the inline exemptions."
    : `\nFAILED: ${violations} site(s) handle dates without naming a zone.`,
);
process.exit(violations === 0 ? 0 : 1);
