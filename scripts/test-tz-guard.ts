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
 * The allowlist below is the documentation for the sites where UTC is the right
 * answer. Three separate review passes disagreed about those, which is exactly
 * why they belong in code rather than in someone's memory. Adding to it is
 * meant to be a deliberate act with a reason attached.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname ?? ".", "..");
const SRC = join(ROOT, "src");

/** file -> why UTC is correct there. */
const ALLOWED: Record<string, string> = {
  "src/lib/tz.ts":
    "the zone layer itself: it reads UTC parts to compute the zone offset, which is the whole point",
  "src/lib/serials-shared.ts":
    "issue prediction steps stored noon-UTC dates in UTC on purpose, which keeps each issue on its intended calendar day",
  "src/lib/marc.ts":
    "MARC 005 is a machine version stamp used only for ordering, so it stays UTC; 008 is a calendar fact and is zoned",
};

const PATTERNS: { name: string; re: RegExp; note: string }[] = [
  {
    name: "server-local day boundary",
    re: /\.setHours\s*\(|\.getDay\s*\(\)|\.getHours\s*\(\)|\.getMinutes\s*\(\)|(?<!getUTC)(?<![A-Za-z])\.getFullYear\s*\(\)|(?<!getUTC)(?<![A-Za-z])\.getMonth\s*\(\)|(?<!getUTC)(?<![A-Za-z])\.getDate\s*\(\)/,
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
    re: /toISOString\s*\(\)\s*\.slice\s*\(\s*0\s*,\s*10\s*\)/,
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

/** Strip comments and string literals so prose about the bug is not a hit. */
function code(text: string): string[] {
  return text.split("\n").map((line) => {
    const noLineComment = line.replace(/\/\/.*$/, "");
    if (/^\s*[*/]/.test(line)) return "";
    return noLineComment
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''");
  });
}

let violations = 0;
const files = walk(SRC).sort();
console.log(`Scanning ${files.length} source files for the four patterns that caused the defect.\n`);

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const allowedFor = ALLOWED[rel];
  const lines = code(readFileSync(file, "utf8"));

  for (const [i, line] of lines.entries()) {
    for (const p of PATTERNS) {
      if (!p.re.test(line)) continue;
      // An options object naming the zone is exactly what we want to see.
      if (p.name === "unzoned formatting" && /timeZone/.test(line)) continue;
      if (allowedFor) continue;
      violations++;
      console.log(`  ${rel}:${i + 1}`);
      console.log(`    ${p.name}: ${line.trim().slice(0, 100)}`);
      console.log(`    ${p.note}`);
    }
  }
}

console.log("\nAllowed, with the reason:");
for (const [file, why] of Object.entries(ALLOWED)) console.log(`  ${file}\n    ${why}`);

console.log(
  violations === 0
    ? "\nCLEAN — no unzoned date handling outside the allowlist."
    : `\nFAILED — ${violations} site(s) handle dates without naming a zone.`,
);
process.exit(violations === 0 ? 0 : 1);
