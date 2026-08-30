"use server";

import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { emitEventAfter } from "@/lib/webhooks";
import { revalidatePath } from "next/cache";
import {
  intakeResource,
  INTAKE_INPUT_MAX,
  FETCH_FAILURE_TEXT,
  type IntakeLinks,
} from "@/lib/resource-intake";

export type IntakeState = {
  ok?: boolean;
  message?: string;
  /** Present on success: what was added, or what was already there. */
  result?: {
    status: "created" | "duplicate";
    title: string;
    authors: string;
    year: number | null;
    publisher: string | null;
    type: string;
    provenance: string;
    /** Plain-English note when the page itself could not be read. */
    warning: string | null;
    links: IntakeLinks;
  };
};

/**
 * Fetching an arbitrary URL costs a request to somebody else's server, so a
 * paste-and-hold-enter should not turn this into a crawler. Generous enough for
 * genuine batch work by hand.
 */
const RATE_LIMIT = 40;
const RATE_WINDOW_S = 300;

/**
 * Add a resource from a pasted link.
 *
 * The submitter is an authenticated member of staff with catalogue rights, so
 * there is no allowlist or pairing step to do: this is the same authority as
 * using the full cataloguing form, reached faster.
 */
export async function addResourceFromUrl(
  _prev: IntakeState,
  formData: FormData,
): Promise<IntakeState> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "CATALOGUE")) {
    return { ok: false, message: "You don't have permission to add to the catalogue." };
  }

  const input = String(formData.get("input") ?? "").trim().slice(0, INTAKE_INPUT_MAX);
  if (!input) return { ok: false, message: "Paste a link or a DOI first." };

  const provider = String(formData.get("provider") ?? "").trim() || null;

  // Keyed on the admin id, never a name or email: rate-limit keys are stored
  // in plaintext in RateWindow and logged verbatim when the limiter fails.
  if (!(await rateLimit(`intake:${admin!.id}`, RATE_LIMIT, RATE_WINDOW_S))) {
    return { ok: false, message: "That is a lot of links at once. Try again in a few minutes." };
  }

  let outcome;
  try {
    outcome = await intakeResource({ input, provider, adminName: admin!.name });
  } catch (e) {
    // A database failure is not the submitter's problem to read about, but it
    // must not surface as a blank crash either.
    console.error("[intake] failed", e instanceof Error ? e.message : e);
    return { ok: false, message: "That could not be saved. Try again, or use the full form." };
  }

  if (outcome.status === "rejected") {
    return { ok: false, message: outcome.reason };
  }

  const warning = outcome.fetchFailure ? FETCH_FAILURE_TEXT[outcome.fetchFailure] : null;

  if (outcome.status === "created") {
    await audit({
      action: "catalogue.intake",
      summary: `Added "${outcome.title}" from a pasted link`,
      entity: "Resource",
      entityId: outcome.id,
      detail: { input, provider, provenance: outcome.provenance, fetchFailure: outcome.fetchFailure },
    });
    emitEventAfter("resources.imported", { count: 1, source: "intake", id: outcome.id });
    revalidatePath("/admin/catalogue");
  }

  return {
    ok: true,
    message:
      outcome.status === "created"
        ? `Added "${outcome.title}".`
        : `Already in the library: "${outcome.title}".`,
    result: {
      status: outcome.status,
      title: outcome.title,
      authors: outcome.authors,
      year: outcome.year,
      publisher: outcome.publisher,
      type: outcome.type,
      provenance: outcome.provenance,
      warning,
      links: outcome.links,
    },
  };
}
