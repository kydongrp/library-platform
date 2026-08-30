"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import {
  PAGE_SIZES,
  GAP,
  DEFAULT_PAGE_SIZE,
  pageWindow,
  pagedQuery,
  type Paging,
} from "@/lib/paging";

/**
 * Table pager: a rows-per-page dropdown and page controls.
 *
 * The current filters arrive as `query` rather than being read with
 * useSearchParams, which keeps this component out of the Suspense rules that
 * apply to that hook and means the links are correct in the server-rendered
 * HTML rather than only after hydration.
 *
 * Page changes are plain links, so they work without JavaScript, are
 * middle-clickable, and are prefetched. Only the dropdown needs the router,
 * because a <select> cannot be a link.
 */
export function TablePager({
  paging,
  query,
  basePath,
  unit = "rows",
  defaultPageSize = DEFAULT_PAGE_SIZE,
  hash,
  className = "",
}: {
  paging: Paging;
  /** Current filters to preserve; empty values are dropped. */
  query: Record<string, string | undefined>;
  basePath: string;
  /** Plural noun for the count, e.g. "rows", "items", "loans". */
  unit?: string;
  /**
   * This screen's preferred size, so the links leave pageSize out of the URL
   * while it is unchanged. Must match what the page passed to resolvePaging, or
   * a link would silently switch the size.
   */
  defaultPageSize?: number;
  /**
   * Element id to return to, without the "#". Needed when the table is one
   * panel among several: otherwise every page change lands the reader at the
   * top of the page and they have to scroll back to where they were.
   */
  hash?: string;
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const href = (page: number, pageSize = paging.pageSize) => {
    const qs = pagedQuery(query, page, pageSize, defaultPageSize);
    const suffix = hash ? `#${hash}` : "";
    return (qs ? `${basePath}?${qs}` : basePath) + suffix;
  };

  const stepCls =
    "inline-flex h-9 min-w-9 items-center justify-center rounded-lg border border-border bg-card px-2.5 text-sm font-medium transition-colors hover:bg-muted";
  const disabledCls =
    "inline-flex h-9 min-w-9 cursor-not-allowed items-center justify-center rounded-lg border border-border bg-muted/40 px-2.5 text-sm font-medium text-muted-foreground/50";

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 ${className}`}
      // Announce the range politely: a screen reader user changing pages hears
      // where they landed instead of having to hunt for it.
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">
          {paging.total === 0 ? (
            <>No {unit}</>
          ) : (
            <>
              Showing <span className="font-medium text-foreground">{paging.from.toLocaleString()}</span>
              {"–"}
              <span className="font-medium text-foreground">{paging.to.toLocaleString()}</span> of{" "}
              <span className="font-medium text-foreground">{paging.total.toLocaleString()}</span> {unit}
            </>
          )}
        </p>

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="whitespace-nowrap">Rows per page</span>
          <select
            aria-label="Rows per page"
            value={paging.pageSize}
            disabled={pending}
            onChange={(e) => {
              // Always return to page 1: the row that was at the top of page 8
              // is not at the top of page 8 once the page size changes, so
              // holding the number would land somewhere arbitrary.
              const next = Number(e.target.value);
              startTransition(() => router.push(href(1, next)));
            }}
            className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        {pending && (
          <span className="text-xs text-muted-foreground" role="status">
            Loading…
          </span>
        )}
      </div>

      {paging.totalPages > 1 && (
        <nav className="flex items-center gap-1" aria-label="Pagination">
          {paging.hasPrev ? (
            <>
              <Link href={href(1)} className={stepCls} aria-label="First page" prefetch={false}>
                ‹‹
              </Link>
              <Link
                href={href(paging.page - 1)}
                className={stepCls}
                aria-label="Previous page"
                prefetch={false}
              >
                ‹
              </Link>
            </>
          ) : (
            <>
              <span className={disabledCls} aria-hidden="true">‹‹</span>
              <span className={disabledCls} aria-hidden="true">‹</span>
            </>
          )}

          {pageWindow(paging.page, paging.totalPages).map((p, i) =>
            p === GAP ? (
              <span
                key={`gap-${i}`}
                className="px-1 text-sm text-muted-foreground"
                aria-hidden="true"
              >
                …
              </span>
            ) : p === paging.page ? (
              <span
                key={p}
                aria-current="page"
                className="inline-flex h-9 min-w-9 items-center justify-center rounded-lg border border-primary bg-primary px-2.5 text-sm font-semibold text-primary-foreground"
              >
                {p}
              </span>
            ) : (
              <Link
                key={p}
                href={href(p)}
                className={stepCls}
                aria-label={`Page ${p}`}
                prefetch={false}
              >
                {p}
              </Link>
            ),
          )}

          {paging.hasNext ? (
            <>
              <Link
                href={href(paging.page + 1)}
                className={stepCls}
                aria-label="Next page"
                prefetch={false}
              >
                ›
              </Link>
              <Link
                href={href(paging.totalPages)}
                className={stepCls}
                aria-label="Last page"
                prefetch={false}
              >
                ››
              </Link>
            </>
          ) : (
            <>
              <span className={disabledCls} aria-hidden="true">›</span>
              <span className={disabledCls} aria-hidden="true">››</span>
            </>
          )}
        </nav>
      )}
    </div>
  );
}
