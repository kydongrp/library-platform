"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { interpretReportPrompt, type NlState } from "@/app/actions/flexi-nl";

/** Idle state. Declared here because a "use server" module may only export
 *  async functions, so the action file cannot hold a plain object. */
const idleNlState: NlState = {};

/**
 * Ask-for-a-report box.
 *
 * Pure UI: nothing prisma-backed is imported here, so the client bundle stays
 * clean. `maxLength` arrives as a prop rather than being imported from
 * flexi-nl, which reaches CUBES and therefore prisma.
 *
 * The box does NOT run the report. It shows what the assistant understood and
 * waits for the admin to press Run. That is the point: the protection against a
 * confidently wrong report is a person reading which cube, fields and period
 * were chosen before they see any figures. A box that went straight to numbers
 * would present a guess as though it were the question asked.
 */

/** Cold start: a blank box invites nothing, so seed it with real questions. */
const EXAMPLES = [
  "Loans per month by member type this year",
  "Which categories were borrowed most last quarter",
  "Fines by member type, year to date",
  "Titles added each month, by format",
  "Spend by fund this financial year",
  "Late issue arrivals by subscription, last 90 days",
];

function InterpretButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-70"
    >
      {pending && (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground" />
      )}
      {pending ? "Reading…" : "Interpret"}
    </button>
  );
}

export function NlReportBox({
  maxLength,
  configured,
}: {
  maxLength: number;
  configured: boolean;
}) {
  const [state, formAction] = useActionState(interpretReportPrompt, idleNlState);
  const [text, setText] = useState("");

  return (
    <div className="mb-6 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="font-display text-lg font-semibold">Ask for a report</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Describe what you want and the assistant will set the criteria below. It can only build
        reports from the five cubes on this page, so it cannot answer about one particular person
        or title, and it will say so rather than guess.
      </p>

      {!configured ? (
        <p className="mt-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Not switched on: <code className="font-mono text-xs">ANTHROPIC_API_KEY</code> is not
          configured for this deployment. Build the report with the criteria below.
        </p>
      ) : (
        <>
          <form action={formAction} className="mt-3">
            <label className="sr-only" htmlFor="nl-prompt">
              Describe the report you want
            </label>
            <textarea
              id="nl-prompt"
              name="prompt"
              rows={2}
              maxLength={maxLength}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. loans per month by member type for the first half of this year"
              className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {text.length}/{maxLength}
              </p>
              <InterpretButton />
            </div>
          </form>

          <div className="mt-3">
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Try
            </p>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setText(ex)}
                  className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs hover:bg-muted"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Success: show the interpretation, then let the admin run it. */}
      {state.ok && state.proposal && (
        <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <p className="text-sm">
            <span className="font-medium">Read as:</span> {state.proposal.reading}
          </p>
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            {(
              [
                ["Report area", state.proposal.detail.cube],
                ["Rows", state.proposal.detail.rows],
                ["Columns", state.proposal.detail.columns],
                ["Figure", state.proposal.detail.measure],
                ["Period", state.proposal.detail.period],
                ["Shown as", state.proposal.detail.view],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="min-w-24 text-muted-foreground">{k}</dt>
                <dd className="font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Link
              href={state.proposal.url}
              className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
            >
              Run this report
            </Link>
            <p className="text-xs text-muted-foreground">
              Not what you meant? Adjust the criteria below and press Apply.
            </p>
          </div>
        </div>
      )}

      {/* A refusal is an answer, not a fault, so it is not styled as an error. */}
      {state.ok === false && state.refused && (
        <div className="mt-4 rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-sm">
            <span className="font-medium">Cannot answer that:</span> {state.message}
          </p>
        </div>
      )}

      {state.ok === false && !state.refused && state.message && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.message}
        </p>
      )}
    </div>
  );
}
