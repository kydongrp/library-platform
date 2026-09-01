/**
 * Deep links into the learner portal.
 *
 * The portal is a separate, already-built system. It owns its own routing, so
 * this side cannot know a record's portal URL: it has to be told the shape.
 *
 * This module outlived the Portal API it was written alongside. That API was
 * removed on 2 Sep 2026; the public new-acquisitions feed still points its
 * items at the portal, so the link template stays.
 *
 *   PORTAL_RESOURCE_URL   A template containing {id}, e.g.
 *                           https://portal.klsi.example/resources/{id}
 *                         Unset means no portal link is offered anywhere,
 *                         which is the current state of this deployment.
 *
 * Deliberately a template rather than a base URL: portals differ on whether a
 * record lives at /resources/:id, /item?id=, or something else, and guessing
 * would produce a link that 404s while looking authoritative.
 */

/** True when a portal link shape has been configured. */
export function portalLinksConfigured(): boolean {
  return !!templateOf();
}

function templateOf(): string | null {
  const raw = (process.env.PORTAL_RESOURCE_URL ?? "").trim();
  if (!raw || !raw.includes("{id}")) return null;
  // Only http(s): a template pointing at anything else would be handed to a
  // browser as a link.
  if (!/^https?:\/\//i.test(raw)) return null;
  return raw;
}

/**
 * The learner-facing URL for a catalogue record, or null when no template is
 * configured or the id is unusable.
 *
 * The id is percent-encoded, so a template placing {id} in a query string is
 * as safe as one placing it in a path.
 */
export function portalResourceUrl(id: string): string | null {
  const template = templateOf();
  if (!template) return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  const url = template.replace("{id}", encodeURIComponent(trimmed));
  try {
    // Round-trip through URL so a template that produces something malformed
    // is caught here rather than rendered as a broken link.
    return new URL(url).toString();
  } catch {
    return null;
  }
}
