// Instant loading state for every navigation inside the Admin Panel. All
// admin pages are force-dynamic, so this fallback shows on each route change
// while the server renders; the sidebar/layout stays interactive around it.
export default function AdminLoading() {
  return (
    <div className="mx-auto max-w-6xl" role="status" aria-label="Loading page">
      {/* Spinner + label */}
      <div className="mb-8 flex items-center gap-3 text-muted-foreground">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-primary" />
        <span className="text-sm font-medium">Loading…</span>
      </div>

      {/* Page-shaped skeleton */}
      <div className="animate-pulse">
        <div className="h-8 w-64 rounded-lg bg-muted" />
        <div className="mt-3 h-4 w-96 max-w-full rounded bg-muted" />

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 rounded-xl border border-border bg-card p-4">
              <div className="h-3 w-20 rounded bg-muted" />
              <div className="mt-3 h-6 w-12 rounded bg-muted" />
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-xl border border-border bg-card p-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 border-b border-border py-3.5 last:border-0">
              <div className="h-9 w-9 shrink-0 rounded-lg bg-muted" />
              <div className="min-w-0 flex-1">
                <div className="h-4 w-1/3 rounded bg-muted" />
                <div className="mt-2 h-3 w-1/2 rounded bg-muted" />
              </div>
              <div className="h-6 w-16 rounded-full bg-muted" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
