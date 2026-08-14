// Instant loading state for routes outside the Admin Panel (landing page,
// staff sign-in): a centred brand mark with a spinner ring.
export default function RootLoading() {
  return (
    <main
      className="flex flex-1 items-center justify-center py-32"
      role="status"
      aria-label="Loading page"
    >
      <div className="flex flex-col items-center gap-4">
        <div className="relative h-16 w-16">
          <span className="absolute inset-0 animate-spin rounded-2xl border-2 border-border border-t-primary" />
          <span className="absolute inset-2 flex animate-pulse items-center justify-center rounded-xl bg-primary font-display text-xl font-bold text-primary-foreground">
            D
          </span>
        </div>
        <p className="text-sm font-medium text-muted-foreground">Loading…</p>
      </div>
    </main>
  );
}
