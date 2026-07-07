"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function PortalSearch({
  defaultValue = "",
  size = "md",
}: {
  defaultValue?: string;
  size?: "md" | "lg";
}) {
  const router = useRouter();
  const [value, setValue] = useState(defaultValue);

  const cls =
    size === "lg"
      ? "h-14 text-base pl-12 pr-4"
      : "h-10 text-sm pl-10 pr-3";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const q = value.trim();
        router.push(q ? `/portal/search?q=${encodeURIComponent(q)}` : "/portal/search");
      }}
      className="relative w-full"
      role="search"
    >
      <span
        className={`pointer-events-none absolute inset-y-0 left-0 flex items-center text-muted-foreground ${
          size === "lg" ? "pl-4" : "pl-3"
        }`}
      >
        ⌕
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search titles, authors, ISBN…"
        className={`w-full rounded-full border border-border bg-card ${cls} shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20`}
      />
    </form>
  );
}
