import Link from "next/link";
import { RESOURCE_TYPE_LABELS } from "@/lib/constants";

/* ---------- Book cover ---------- */

export function BookCover({
  title,
  author,
  color,
  type,
  size = "md",
  imageId,
}: {
  title: string;
  author: string;
  color: string;
  type?: string;
  size?: "sm" | "md" | "lg";
  /**
   * A common cover image from the pool, if one was assigned. Absent, the
   * coloured placeholder below is what a record has always had.
   */
  imageId?: string | null;
}) {
  const dims = {
    sm: "h-24 w-16 text-[9px] p-2",
    md: "h-44 w-30 text-xs p-3",
    lg: "h-64 w-44 text-sm p-4",
  }[size];

  if (imageId) {
    // A plain <img>, not next/image: these are small database-served bytes
    // behind an authenticated route, so the optimiser would add a second fetch
    // and a cache layer for no gain. The title is the alt text because that is
    // what the image stands in for, and a house cover carries no other meaning.
    return (
      <div className={`relative ${dims} shrink-0 overflow-hidden rounded-md shadow-md bg-stone-100`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/covers/${imageId}`}
          alt={`Cover: ${title}`}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      </div>
    );
  }

  return (
    <div
      className={`relative ${dims} shrink-0 overflow-hidden rounded-md shadow-md flex flex-col justify-between text-white`}
      style={{
        background: `linear-gradient(150deg, ${color} 0%, ${shade(color, -28)} 100%)`,
      }}
    >
      {/* spine highlight */}
      <span className="absolute inset-y-0 left-0 w-1.5 bg-black/15" />
      <span className="absolute inset-y-0 left-1.5 w-px bg-white/25" />
      <p className="font-display font-semibold leading-tight line-clamp-4 pl-1">
        {title}
      </p>
      <div className="pl-1">
        <p className="opacity-85 leading-tight line-clamp-2">{author}</p>
        {type && (
          <p className="mt-1 opacity-70 uppercase tracking-wide text-[0.6em]">
            {RESOURCE_TYPE_LABELS[type] ?? type}
          </p>
        )}
      </div>
    </div>
  );
}

// Darken/lighten a hex color by percent (negative = darken).
function shade(hex: string, percent: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + Math.round(2.55 * percent)));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + Math.round(2.55 * percent)));
  const b = Math.max(0, Math.min(255, (n & 0xff) + Math.round(2.55 * percent)));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

/* ---------- Badges ---------- */

type Tone = "neutral" | "primary" | "success" | "danger" | "accent" | "muted";

const TONES: Record<Tone, string> = {
  neutral: "bg-stone-100 text-stone-700 ring-stone-200",
  primary: "bg-teal-50 text-teal-800 ring-teal-200",
  success: "bg-green-50 text-green-800 ring-green-200",
  danger: "bg-red-50 text-red-700 ring-red-200",
  accent: "bg-amber-50 text-amber-800 ring-amber-200",
  muted: "bg-stone-50 text-stone-500 ring-stone-200",
};

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/* ---------- Card ---------- */

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-border bg-card shadow-sm ${className}`}
    >
      {children}
    </div>
  );
}

/* ---------- Buttons & links ---------- */

const BTN_BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export const buttonVariants = {
  primary: `${BTN_BASE} bg-primary text-primary-foreground hover:bg-primary-hover px-4 py-2`,
  accent: `${BTN_BASE} bg-accent text-white hover:brightness-95 px-4 py-2`,
  outline: `${BTN_BASE} border border-border bg-card hover:bg-muted px-4 py-2`,
  ghost: `${BTN_BASE} hover:bg-muted px-3 py-2`,
  danger: `${BTN_BASE} border border-red-200 text-red-700 bg-red-50 hover:bg-red-100 px-4 py-2`,
};

export function ButtonLink({
  href,
  variant = "primary",
  className = "",
  children,
}: {
  href: string;
  variant?: keyof typeof buttonVariants;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={`${buttonVariants[variant]} ${className}`}>
      {children}
    </Link>
  );
}

/* ---------- Empty state ---------- */

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-14 text-center">
      {icon && <div className="mb-3 text-stone-300">{icon}</div>}
      <p className="font-display text-lg text-foreground">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/* ---------- Section heading ---------- */

export function SectionHeading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <h2 className="font-display text-2xl font-semibold text-foreground">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  );
}
