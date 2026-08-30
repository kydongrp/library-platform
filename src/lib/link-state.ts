/**
 * What the access scan actually established about a link.
 *
 * The scan used to answer a yes/no question, with ok defined as
 * `status < 500 && status !== 404 && status !== 410`. That is the right rule
 * for deciding whether a link is DEAD, and the wrong one for the sentence the
 * dashboard printed on top of it: "Every digital access link resolved."
 *
 * Measured against the live catalogue on 31 August 2026, 44 links: 15 returned
 * a real document. 25 returned 202 with an empty body, which is IEEE's gate
 * refusing a non-browser client. 2 returned 403 carrying a bot-challenge page.
 * 1 was a genuine 404 and 1 did not respond. So on the day the screen claimed
 * every link resolved, the scanner had seen a document for barely a third of
 * them, and simply had not been asked to distinguish the rest.
 *
 * Three states, because there are three things that happen:
 *
 *   OK          the server returned the document
 *   BROKEN      the link is dead: 404, 410, 5xx, or no response at all
 *   UNVERIFIED  the server answered, and did not hand over the document
 *
 * UNVERIFIED is not a failure. A subscription wall answering 403 is the system
 * working exactly as designed, and so is a publisher declining to serve a
 * crawler. It is a statement about the limits of what this scanner can see
 * from outside, and it belongs on screen as itself rather than rounded up into
 * a tick or down into an alarm.
 *
 * Pure: no database, no network, no env. Client-safe.
 */

export type LinkState = "OK" | "BROKEN" | "UNVERIFIED";

/**
 * Codes that mean "answered, but you are not getting the document".
 *
 *   202  accepted and handed back nothing; a bot gate in practice
 *   401  authentication required
 *   403  forbidden: a subscription wall, or a challenge page
 *   429  rate limited
 *
 * None of these say the resource is missing, which is why they are not BROKEN.
 * None of them are evidence a reader can open it either.
 */
const NOT_DELIVERED = new Set([202, 401, 403, 429]);

/**
 * Classify one stored check. Returns null when the link has never been scanned,
 * which is different from all three states and must not be shown as any of them.
 */
export function linkState(
  check: { ok: boolean; statusCode: number | null } | null | undefined,
): LinkState | null {
  if (!check) return null;
  if (!check.ok) return "BROKEN";
  if (check.statusCode !== null && NOT_DELIVERED.has(check.statusCode)) return "UNVERIFIED";
  return "OK";
}

/** Wording for staff, who can act on the difference. */
export const LINK_STATE_LABEL: Record<LinkState, string> = {
  OK: "Link resolved",
  BROKEN: "Link broken",
  UNVERIFIED: "Not verified",
};

export const LINK_STATE_NOTE: Record<LinkState, string> = {
  OK: "The scan retrieved the page.",
  BROKEN: "The scan could not reach the page. A reader clicking this will fail.",
  UNVERIFIED:
    "The provider answered but did not serve the page to the scanner, which is what a subscription wall or a bot gate looks like from outside. It may well open normally in a browser.",
};

/**
 * A single known limit, stated so nobody has to rediscover it: a server that
 * returns 200 and a challenge page still reads as OK here, because the scanner
 * records the status code and not the body. Nothing in the catalogue does that
 * today. If one starts to, the fix is to record what the body looked like at
 * scan time, not to widen the code list above.
 */
export const LINK_STATE_LIMIT =
  "Classified from the HTTP status. A 200 carrying a challenge page would still read as resolved.";
