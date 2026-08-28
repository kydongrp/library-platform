/**
 * Pagination maths.
 *
 *   npx tsx scripts/test-paging.ts
 *
 * Pure: no database, no network. Off-by-ones here are invisible in review and
 * obvious in production: a row silently missing from the boundary of every
 * page, or "Showing 1-50 of 0".
 */
import {
  PAGE_SIZES,
  DEFAULT_PAGE_SIZE,
  normalisePageSize,
  resolvePaging,
  pageWindow,
  pagedQuery,
  GAP,
} from "../src/lib/paging";

let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}

console.log("Page size is an allowlist, not a clamp:");
{
  for (const n of PAGE_SIZES) {
    check(`${n} is accepted`, normalisePageSize(n) === n);
    check(`"${n}" as a string is accepted`, normalisePageSize(String(n)) === n);
  }
  check("the default is one of the offered sizes", (PAGE_SIZES as readonly number[]).includes(DEFAULT_PAGE_SIZE));
  check("an unoffered size falls back", normalisePageSize(37) === DEFAULT_PAGE_SIZE);
  // The whole point: a huge pageSize would rebuild the render-everything bug.
  check("999999 is refused", normalisePageSize(999999) === DEFAULT_PAGE_SIZE);
  check("0 is refused", normalisePageSize(0) === DEFAULT_PAGE_SIZE);
  check("a negative is refused", normalisePageSize(-50) === DEFAULT_PAGE_SIZE);
  check("nonsense is refused", normalisePageSize("all") === DEFAULT_PAGE_SIZE);
  check("null is refused", normalisePageSize(null) === DEFAULT_PAGE_SIZE);
  check("undefined is refused", normalisePageSize(undefined) === DEFAULT_PAGE_SIZE);
  check("an injection attempt is refused", normalisePageSize("50; DROP TABLE") === DEFAULT_PAGE_SIZE);
  check("a float is refused", normalisePageSize("25.5") === DEFAULT_PAGE_SIZE || normalisePageSize("25.5") === 25);
}

console.log("\nSlice bounds and the displayed range agree:");
{
  const p1 = resolvePaging(3247, 1, 50);
  check("page 1 starts at 0", p1.start === 0);
  check("page 1 ends at 50", p1.end === 50);
  check("page 1 displays 1-50", p1.from === 1 && p1.to === 50);
  check("total pages rounds up", p1.totalPages === 65, `got ${p1.totalPages}`);
  check("page 1 has no previous", !p1.hasPrev);
  check("page 1 has a next", p1.hasNext);

  const p2 = resolvePaging(3247, 2, 50);
  check("page 2 starts where page 1 ended", p2.start === p1.end);
  check("page 2 displays 51-100", p2.from === 51 && p2.to === 100);

  const last = resolvePaging(3247, 65, 50);
  check("the last page is partial", last.end === 3247 && last.to === 3247);
  check("the last page start is right", last.start === 3200);
  check("the last page has no next", !last.hasNext);
  check("the last page has a previous", last.hasPrev);

  // Every row appears exactly once across all pages, and none twice.
  const size = 25;
  const total = 261;
  const seen = new Set<number>();
  let overlap = 0;
  const pages = resolvePaging(total, 1, size).totalPages;
  for (let p = 1; p <= pages; p++) {
    const r = resolvePaging(total, p, size);
    for (let i = r.start; i < r.end; i++) {
      if (seen.has(i)) overlap++;
      seen.add(i);
    }
  }
  check("every row is covered exactly once", seen.size === total && overlap === 0, `covered ${seen.size}, overlaps ${overlap}`);
  check("an exact multiple needs no extra page", resolvePaging(250, 1, 25).totalPages === 10);
  check("one row over adds a page", resolvePaging(251, 1, 25).totalPages === 11);
}

console.log("\nEmpty and out-of-range inputs behave:");
{
  const none = resolvePaging(0, 1, 50);
  check("zero rows is still one page", none.totalPages === 1);
  check("zero rows displays 0-0, not 1-0", none.from === 0 && none.to === 0);
  check("zero rows has no next or previous", !none.hasNext && !none.hasPrev);
  check("zero rows slices to nothing", none.start === 0 && none.end === 0);

  // Someone on page 40 switches to 500 rows per page: clamp, do not show an
  // empty table.
  const past = resolvePaging(300, 40, 500);
  check("a page past the end clamps to the last", past.page === 1 && past.totalPages === 1);
  const past2 = resolvePaging(3247, 999, 50);
  check("a wildly high page clamps to the last", past2.page === 65);
  check("the clamped page still shows rows", past2.to === 3247 && past2.from === 3201);

  check("page 0 becomes page 1", resolvePaging(100, 0, 25).page === 1);
  check("a negative page becomes page 1", resolvePaging(100, -5, 25).page === 1);
  check("a non-numeric page becomes page 1", resolvePaging(100, "abc", 25).page === 1);
  check("a null page becomes page 1", resolvePaging(100, null, 25).page === 1);
  check("a negative total is treated as empty", resolvePaging(-3, 1, 25).total === 0);
  check("a fractional total is floored", resolvePaging(10.7, 1, 25).total === 10);
}

console.log("\nThe page list always offers first and last:");
{
  const eq = (a: unknown[], b: unknown[]) => JSON.stringify(a) === JSON.stringify(b);

  check("one page", eq(pageWindow(1, 1), [1]));
  check("zero pages is still one", eq(pageWindow(1, 0), [1]));
  check("three pages, all shown", eq(pageWindow(2, 3), [1, 2, 3]));
  check("five pages from the middle", eq(pageWindow(3, 5), [1, 2, 3, 4, 5]));

  const mid = pageWindow(10, 20);
  check("first is always present", mid[0] === 1);
  check("last is always present", mid.at(-1) === 20);
  check("the current page is present", mid.includes(10));
  check("gaps appear on both sides", mid.filter((x) => x === GAP).length === 2, JSON.stringify(mid));
  check("middle window is 1..gap..9,10,11..gap..20", eq(mid, [1, GAP, 9, 10, 11, GAP, 20]), JSON.stringify(mid));

  const near = pageWindow(2, 20);
  check("near the start there is no leading gap", near[0] === 1 && near[1] !== GAP, JSON.stringify(near));
  const nearEnd = pageWindow(19, 20);
  check("near the end there is no trailing gap", nearEnd.at(-1) === 20 && nearEnd.at(-2) !== GAP, JSON.stringify(nearEnd));

  // A "…" standing in for exactly one page is worse than showing the page.
  const single = pageWindow(4, 7);
  check("a single missing page is shown, not elided", !single.includes(GAP), JSON.stringify(single));
  check("that list is complete", eq(single, [1, 2, 3, 4, 5, 6, 7]), JSON.stringify(single));

  const wide = pageWindow(10, 20, 2);
  check("a wider span shows more neighbours", eq(wide, [1, GAP, 8, 9, 10, 11, 12, GAP, 20]), JSON.stringify(wide));

  // No duplicates anywhere, at any position.
  for (const [cur, tot] of [[1, 20], [2, 20], [3, 20], [10, 20], [18, 20], [19, 20], [20, 20], [1, 2], [1, 3]] as const) {
    const w = pageWindow(cur, tot).filter((x): x is number => x !== GAP);
    check(`no duplicate pages at ${cur}/${tot}`, new Set(w).size === w.length, JSON.stringify(w));
  }
}

console.log("\nLinks keep the current filters:");
{
  const base = { report: "items-inventory", from: "2026-01-01", to: "", memberType: "" };
  const q = pagedQuery(base, 3, 100);
  check("the report is kept", q.includes("report=items-inventory"));
  check("a set filter is kept", q.includes("from=2026-01-01"));
  check("empty filters are dropped", !q.includes("to=") && !q.includes("memberType="));
  check("the page is set", q.includes("page=3"));
  check("a non-default size is set", q.includes("pageSize=100"));

  const first = pagedQuery(base, 1, DEFAULT_PAGE_SIZE);
  check("page 1 is omitted", !first.includes("page="));
  check("the default size is omitted", !first.includes("pageSize="));
  check("filters survive on page 1", first.includes("report=items-inventory"));

  const encoded = pagedQuery({ report: "x", memberType: "A B&C" }, 1, DEFAULT_PAGE_SIZE);
  check("values are encoded", encoded.includes("memberType=A+B%26C"), encoded);
}

console.log(
  failures === 0
    ? "\nCLEAN: every row appears on exactly one page, out-of-range input clamps instead of showing an empty table, and pageSize cannot be widened past the offered sizes."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
