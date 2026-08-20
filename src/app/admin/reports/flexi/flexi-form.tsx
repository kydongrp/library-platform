"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

/**
 * The pivot criteria form. Client-side it submits as a soft navigation so the
 * admin loading skeleton and a pending spinner show while the server pivots
 * (the standing rule: every navigation shows a loading state). Before
 * hydration it degrades to a native GET submit of the same params.
 *
 * Pure UI: no prisma-backed imports, keeps the client bundle clean.
 */
export function FlexiForm({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const qs = new URLSearchParams();
        for (const [k, v] of fd.entries()) if (typeof v === "string") qs.set(k, v);
        startTransition(() => router.push(`/admin/reports/flexi?${qs.toString()}`));
      }}
    >
      {children}
      <button
        type="submit"
        disabled={pending}
        className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-70"
      >
        {pending && (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground" />
        )}
        {pending ? "Computing…" : "Apply"}
      </button>
    </form>
  );
}
