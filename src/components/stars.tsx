// Star display (server-safe) — filled/empty stars for a 0-5 rating.
export function Stars({
  rating,
  size = "text-base",
}: {
  rating: number;
  size?: string;
}) {
  const rounded = Math.round(rating);
  return (
    <span className={`${size} leading-none tracking-tight`} aria-label={`${rating.toFixed(1)} out of 5 stars`}>
      <span className="text-amber-500">{"★".repeat(Math.max(0, Math.min(5, rounded)))}</span>
      <span className="text-stone-300">{"★".repeat(Math.max(0, 5 - rounded))}</span>
    </span>
  );
}
