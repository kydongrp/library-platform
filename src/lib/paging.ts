/**
 * Pagination maths. Pure: no React, no database, no request.
 *
 * Reports can return up to MODULE_ROW_CAP (10,000) rows, and the reports page
 * rendered every one of them into a single table. Items Inventory on a real
 * collection is thousands of rows, which is a slow page, an unusable scroll,
 * and a browser doing layout on 10,000 table rows nobody asked to see.
 *
 * The arithmetic lives here rather than in the component because off-by-ones in
 * paging are easy to write and invisible until someone notices the last row of
 * every page is missing.
 */

/** Offered in the rows-per-page control, smallest first. */
export const PAGE_SIZES = [25, 50, 100, 250, 500] as const;

export const DEFAULT_PAGE_SIZE = 50;

/**
 * Coerce a page-size query parameter to one we actually offer.
 *
 * An allowlist, not a clamp: `?pageSize=999999` would otherwise reintroduce
 * exactly the render-everything problem this exists to solve, and it is a
 * trivially guessable way for anyone to make the server build a huge page.
 */
export function normalisePageSize(
  raw: string | number | null | undefined,
  fallback: number = DEFAULT_PAGE_SIZE,
): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if ((PAGE_SIZES as readonly number[]).includes(n)) return n;
  // A screen may prefer a denser default (a shelf list is scanned, a report is
  // read), but only from the offered sizes: a fallback outside them would put a
  // value in the dropdown that the dropdown cannot show as selected.
  return (PAGE_SIZES as readonly number[]).includes(fallback) ? fallback : DEFAULT_PAGE_SIZE;
}

export type Paging = {
  /** 1-based, always within 1..totalPages. */
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** Slice bounds for Array.prototype.slice. */
  start: number;
  end: number;
  /** 1-based inclusive row numbers for display; both 0 when there are no rows. */
  from: number;
  to: number;
  hasPrev: boolean;
  hasNext: boolean;
};

/**
 * Work out which slice of `total` rows to show.
 *
 * A page number past the end is clamped to the last page rather than showing an
 * empty table: it happens whenever someone is on page 40 and changes the rows
 * per page to 500, and an empty screen reads as "the report broke".
 */
export function resolvePaging(
  total: number,
  rawPage: string | number | null | undefined,
  rawPageSize: string | number | null | undefined,
  fallbackPageSize: number = DEFAULT_PAGE_SIZE,
): Paging {
  const pageSize = normalisePageSize(rawPageSize, fallbackPageSize);
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const totalPages = Math.max(1, Math.ceil(safeTotal / pageSize));

  const requested =
    typeof rawPage === "number" ? rawPage : Number.parseInt(String(rawPage ?? ""), 10);
  const page = Number.isFinite(requested) ? Math.min(Math.max(1, requested), totalPages) : 1;

  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, safeTotal);

  return {
    page,
    pageSize,
    total: safeTotal,
    totalPages,
    start,
    end,
    from: safeTotal === 0 ? 0 : start + 1,
    to: end,
    hasPrev: page > 1,
    hasNext: page < totalPages,
  };
}

/** A gap in the page list, rendered as an ellipsis. */
export const GAP = "gap" as const;

/**
 * The page numbers to offer as buttons.
 *
 * Always includes the first and last page so those are one click away, plus a
 * window around the current page. Gaps are only inserted where they actually
 * save a button: a "…" standing in for a single page is worse than the page.
 */
export function pageWindow(
  current: number,
  totalPages: number,
  span = 1,
): (number | typeof GAP)[] {
  if (totalPages <= 1) return [1];

  const wanted = new Set<number>([1, totalPages]);
  for (let p = current - span; p <= current + span; p++) {
    if (p >= 1 && p <= totalPages) wanted.add(p);
  }

  const sorted = [...wanted].sort((a, b) => a - b);
  const out: (number | typeof GAP)[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const prev = sorted[i - 1];
    if (prev !== undefined) {
      const missing = p - prev - 1;
      // One missing page becomes the page itself; two or more become a gap.
      if (missing === 1) out.push(prev + 1);
      else if (missing > 1) out.push(GAP);
    }
    out.push(p);
  }
  return out;
}

/**
 * Build a query string that keeps the current filters and changes only paging.
 *
 * Empty values are dropped so the address bar stays readable, and `page` is
 * omitted when it is 1 for the same reason.
 */
export function pagedQuery(
  base: Record<string, string | undefined>,
  page: number,
  pageSize: number,
  defaultPageSize: number = DEFAULT_PAGE_SIZE,
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) {
    if (v) q.set(k, v);
  }
  if (page > 1) q.set("page", String(page));
  if (pageSize !== defaultPageSize) q.set("pageSize", String(pageSize));
  return q.toString();
}
