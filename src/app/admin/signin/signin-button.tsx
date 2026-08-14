"use client";

import { useFormStatus } from "react-dom";

/**
 * Staff-account row button with a pending spinner: signing in runs a server
 * action then redirects, so the click needs immediate feedback. The group
 * badge swaps to a fixed-size spinner while pending (no layout shift).
 */
export function SignInRowButton({
  avatar,
  name,
  email,
  group,
}: {
  avatar: string;
  name: string;
  email: string;
  group: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`flex w-full items-center gap-3 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-md ${
        pending ? "opacity-70" : ""
      }`}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
        {avatar}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{name}</p>
        <p className="truncate text-sm text-muted-foreground">{email}</p>
      </div>
      {pending ? (
        <span className="flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-xs font-medium text-stone-600">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-stone-400 border-t-transparent" />
          Signing in…
        </span>
      ) : (
        <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-stone-600">
          {group}
        </span>
      )}
    </button>
  );
}
