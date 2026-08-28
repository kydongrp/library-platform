/**
 * Turn a librarian's question into a FlexiReports spec, using Claude.
 *
 * Server-only. The model's entire job is to choose from a menu:
 *
 *   which cube, which dimension for rows, optionally one for columns, which
 *   measure, and which named period.
 *
 * It is given the menu (generated from the live CUBES array) and today's date,
 * and nothing else. In particular it is NOT given any row data: no member
 * names, no titles, no loans. The only thing that leaves this system is the
 * question the admin typed plus a static description of the report vocabulary.
 * That is worth knowing for a government deployment, and it is the reason this
 * design does not summarise results with a model.
 *
 * Everything it returns is validated by validateNlSpec against the same CUBES
 * array before it can become a report.
 */
import Anthropic from "@anthropic-ai/sdk";
import { aiConfigured } from "@/lib/ai-draft";
import { zonedDayKey, LIBRARY_TZ } from "@/lib/tz";
import {
  catalogueForPrompt,
  specJsonSchema,
  validateNlSpec,
  PROMPT_MAX,
  NAMED_PERIODS,
  type NlResult,
} from "@/lib/flexi-nl";

export { aiConfigured as nlReportsConfigured };

/**
 * Small output, so a small budget. The reply is one flat JSON object of about
 * ten short fields; 1000 tokens is generous and bounds the cost of a runaway
 * generation.
 */
const MAX_TOKENS = 1_000;

function systemPrompt(now: Date): string {
  return `You turn a librarian's question into a report specification for a library management system. You do not write queries or SQL. You choose from a fixed menu, and nothing else.

Today is ${zonedDayKey(now)} in the library's timezone (${LIBRARY_TZ}).

The report engine has five cubes. Each cube has its own dimensions (ways to group) and measures (what to count). You must pick a cube first, then a row dimension, a measure, and optionally a column dimension to break the rows down by. A dimension or measure may ONLY be used with the cube it is listed under.

${catalogueForPrompt()}

For the date range, name one of these periods rather than calculating dates yourself:
${NAMED_PERIODS.filter((p) => p !== "custom").join(", ")}
Use "custom" with from and to as YYYY-MM-DD ONLY when the question names specific dates or a range none of the above expresses (for example "the first half of 2026", or "between March and May").

Remember that each cube's dates filter on a different thing: check the "dates filter on" line. A question about loans in June means loans BORROWED in June, which is the circulation cube. A question about books added in June is the collection cube.

Rules:
- Choose the cube whose "what it counts" matches what the question is actually counting. "How many members borrowed" counts members but lives in circulation, as the "borrowers" measure.
- Prefer a time dimension for rows when the question implies a trend ("per month", "over time", "by year").
- Only set a column dimension when the question actually asks for a breakdown ("by member type", "split by category"). Otherwise leave it null.
- Set view to "stacked" or "columns" only when you also set a column dimension. Use "bar" for a simple ranking, "table" when a chart would not help.
- "reading" must restate, in one plain sentence, the question you are answering, including the period. The librarian uses it to check you understood. Do not describe your reasoning.

If the question cannot be answered from these cubes, set ok to false and explain in one sentence what is missing and what they could ask instead. Do this rather than choosing the nearest cube: a confidently wrong report is worse than no report. Examples of questions that must be refused: anything about a single named person or title, anything needing data the cubes do not carry (staff who shelved an item, opening hours, budgets outside acquisitions), and anything that is not a request for a report.`;
}

export type InterpretOutcome =
  | { kind: "ok"; result: NlResult }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string };

/**
 * Ask the model to interpret one question.
 *
 * Never throws: the caller is a server action rendering a message to an admin,
 * and an unhandled SDK error there would surface as a generic crash.
 */
export async function interpretReportRequest(
  rawPrompt: string,
  now: Date = new Date(),
): Promise<InterpretOutcome> {
  const prompt = rawPrompt.trim().slice(0, PROMPT_MAX);
  if (!prompt) return { kind: "error", message: "Type a question first." };
  if (!aiConfigured()) return { kind: "unconfigured" };

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: MAX_TOKENS,
      output_config: {
        // Picking from a menu is not a reasoning-heavy task, and a low effort
        // keeps it quick enough to sit behind a button press.
        effort: "low",
        format: { type: "json_schema", schema: specJsonSchema() },
      },
      system: systemPrompt(now),
      messages: [{ role: "user", content: prompt }],
    });

    if (response.stop_reason === "refusal") {
      return {
        kind: "error",
        message: "The assistant declined to interpret that request.",
      };
    }
    if (response.stop_reason === "max_tokens") {
      return { kind: "error", message: "The interpretation was cut off. Try a shorter question." };
    }

    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text) return { kind: "error", message: "The assistant returned nothing to interpret." };

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: "error", message: "The assistant's reply could not be read." };
    }

    return { kind: "ok", result: validateNlSpec(parsed, now) };
  } catch (e) {
    // Includes an invalid or revoked API key, a network failure, and a rate
    // limit from Anthropic. None of these should look like a bad question.
    const detail = e instanceof Error ? e.message : "unknown error";
    console.error("[flexi-nl] interpretation failed:", detail);
    return {
      kind: "error",
      message: "The assistant could not be reached. Build the report with the dropdowns below.",
    };
  }
}
