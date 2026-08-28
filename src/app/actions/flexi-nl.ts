"use server";

import { getCurrentAdmin, canView } from "@/lib/admin-session";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { interpretReportRequest, nlReportsConfigured } from "@/lib/flexi-ai";
import { describeSpec, specToQuery, PROMPT_MAX, type FlexiSpec } from "@/lib/flexi-nl";

/**
 * Interpret a natural-language report request.
 *
 * Deliberately does NOT redirect to the report. It returns the interpretation
 * for the admin to read and confirm, because the whole safeguard against a
 * confidently wrong answer is that a person sees which cube, fields and period
 * were chosen before they read any figures. Auto-running would present a guess
 * as though it were the question that was asked.
 */
export type NlState = {
  ok?: boolean;
  message?: string;
  /** Present on success: the report to run, and how to describe it. */
  proposal?: {
    url: string;
    reading: string;
    detail: { cube: string; rows: string; columns: string; measure: string; period: string; view: string };
  };
  /** The question, echoed back so the box keeps its contents. */
  prompt?: string;
  /** True when the model said the question cannot be answered from the cubes. */
  refused?: boolean;
};

// The idle state lives in the client component, not here: every export from a
// "use server" module must be an async server function, so a plain object would
// be invalid. Types are erased at compile time, so NlState above is fine.

/** Per-admin budget. Each interpretation is a paid API call. */
const RATE_LIMIT = 20;
const RATE_WINDOW_S = 300;

export async function interpretReportPrompt(
  _prev: NlState,
  formData: FormData,
): Promise<NlState> {
  const admin = await getCurrentAdmin();
  // Same permission as reading a report: this produces a link to one.
  if (!canView(admin, "REPORTS")) {
    return { ok: false, message: "You don't have permission to run reports." };
  }

  const prompt = String(formData.get("prompt") ?? "").trim().slice(0, PROMPT_MAX);
  if (!prompt) return { ok: false, message: "Type a question first." };

  if (!nlReportsConfigured()) {
    return {
      ok: false,
      prompt,
      message:
        "Report assistance is not switched on: ANTHROPIC_API_KEY is not configured. Build the report with the dropdowns below.",
    };
  }

  // Keyed on the admin's id, never a name or email: rate-limit keys are stored
  // in plaintext in RateWindow and logged verbatim when the limiter fails.
  if (!(await rateLimit(`flexi-nl:${admin!.id}`, RATE_LIMIT, RATE_WINDOW_S))) {
    return {
      ok: false,
      prompt,
      message: "That is a lot of questions in a short time. Try again in a few minutes.",
    };
  }

  const outcome = await interpretReportRequest(prompt);

  if (outcome.kind === "unconfigured") {
    return { ok: false, prompt, message: "Report assistance is not switched on." };
  }
  if (outcome.kind === "error") {
    return { ok: false, prompt, message: outcome.message };
  }

  const result = outcome.result;

  if (!result.ok) {
    // A refusal is a legitimate answer, not a failure. Audited too, because a
    // pattern of refusals is the most useful signal for what to build next.
    await audit({
      action: "reports.nlRefused",
      summary: `Report assistant could not answer: "${prompt.slice(0, 120)}"`,
      entity: "Report",
      detail: { prompt, kind: result.kind, reason: result.reason },
    });
    return { ok: false, prompt, refused: result.kind === "refused", message: result.reason };
  }

  const spec: FlexiSpec = result.spec;
  const url = `/admin/reports/flexi?${specToQuery(spec)}`;

  await audit({
    action: "reports.nlInterpreted",
    summary: `Report assistant read "${prompt.slice(0, 80)}" as ${spec.cube}/${spec.row}/${spec.measure}`,
    entity: "Report",
    detail: { prompt, spec },
  });

  return {
    ok: true,
    prompt,
    proposal: { url, reading: spec.reading, detail: describeSpec(spec) },
  };
}
