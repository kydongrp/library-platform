"use client";

import { useRef, useState } from "react";
import { allPlaceholders } from "@/lib/template-defs";

type Notice = { code: string; name: string };

/**
 * Describe availability in the shortest true way.
 *
 * resourceTitle appears in nine of twelve notices, so listing them is longer and
 * less useful than naming the three it is missing from.
 */
function availability(usedBy: string[], notices: Notice[]): { summary: string; detail: string | null } {
  const nameOf = (code: string) => notices.find((n) => n.code === code)?.name ?? code;
  const total = notices.length;
  if (usedBy.length >= total) return { summary: "Every notice", detail: null };

  if (usedBy.length > total / 2) {
    const missing = notices.filter((n) => !usedBy.includes(n.code)).map((n) => n.name);
    return {
      summary: `${usedBy.length} of ${total} notices`,
      detail: `not in ${missing.join(", ")}`,
    };
  }
  return {
    summary: `${usedBy.length} of ${total} notices`,
    detail: usedBy.map(nameOf).join(", "),
  };
}

export function PlaceholderReference({ notices }: { notices: Notice[] }) {
  const rows = allPlaceholders();
  // Reference material, so it opens by default; collapsing keeps the notice
  // editors within reach on a return visit. Built from a button and a hidden
  // region rather than <details>, because React re-asserts the open attribute
  // on a details element and the panel snaps back open. Mirrored into state because the
  // marker has to follow it, and Tailwind's group-open variant does not
  // compile to anything here.
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = async (name: string) => {
    const token = `{{${name}}}`;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(name);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1400);
    } catch {
      // Clipboard access can be refused; the token is on screen to type.
    }
  };

  return (
    <section className="mb-5 rounded-xl border border-border bg-card">
      <h2>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls="placeholder-reference"
          className="flex w-full cursor-pointer items-center gap-2.5 px-5 py-3.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span
            aria-hidden
            className={`text-[10px] leading-none text-muted-foreground transition-transform duration-150 motion-reduce:transition-none ${
              open ? "rotate-90" : ""
            }`}
          >
            ▶
          </span>
          <span className="font-display text-lg font-semibold">Placeholders</span>
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
            {rows.length} available
          </span>
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {open ? "Click a token to copy it" : "Show"}
          </span>
        </button>
      </h2>

      <div id="placeholder-reference" hidden={!open} className="border-t border-border px-5 py-4">
        <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
          These are every placeholder the system can substitute. A notice only receives the ones
          listed against it below, and anything it does not supply is{" "}
          <strong className="font-medium text-foreground">left visible in the message</strong> rather
          than blanked, so a misspelled token shows up as {"{{"}typo{"}}"} in the sent notice instead
          of disappearing.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="pb-2 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Token
                </th>
                <th className="pb-2 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Becomes
                </th>
                <th className="pb-2 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Example
                </th>
                <th className="pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Available in
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const { summary, detail } = availability(p.usedBy, notices);
                return (
                  <tr key={p.name} className="border-b border-border/60 align-top last:border-0">
                    <td className="py-2.5 pr-4">
                      <button
                        type="button"
                        onClick={() => copy(p.name)}
                        title={`Copy {{${p.name}}}`}
                        className="rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        {`{{${p.name}}}`}
                      </button>
                      {copied === p.name && (
                        <span className="ml-2 text-xs font-medium text-success">Copied</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-muted-foreground">{p.resolvesTo}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-muted-foreground">
                      {p.example}
                    </td>
                    <td className="py-2.5">
                      {p.universal ? (
                        <span className="font-medium text-primary">Every notice</span>
                      ) : (
                        <>
                          <span className="whitespace-nowrap">{summary}</span>
                          {detail && (
                            <span className="block text-xs text-muted-foreground">{detail}</span>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          The list is derived from the notices themselves, so it stays complete as notices change.
          Adding a placeholder to a notice without describing it here is a build error, not a silent
          gap.
        </p>
      </div>
    </section>
  );
}
