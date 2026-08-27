/**
 * Pure logic for the WhatsApp submission bot: no network, no database, no env.
 *
 * Everything here is decided by the message text and the request bytes alone,
 * which is what makes it testable (scripts/test-whatsapp.ts). The I/O half
 * lives in src/lib/whatsapp.ts.
 *
 * Three jobs:
 *   1. Decide whether an inbound webhook is genuinely from Meta (signature).
 *   2. Work out what a sender actually asked for (a URL, a DOI, or help).
 *   3. Normalise phone numbers so an allowlist entry an admin typed by hand
 *      matches the digits Meta puts in the payload.
 */
import { createHash, createHmac, timingSafeEqual } from "crypto";

/* ---------- 1. Webhook authenticity ---------- */

/**
 * Verify Meta's X-Hub-Signature-256 over the RAW request body.
 *
 * The signature covers the exact bytes Meta sent. Re-serialising the parsed
 * JSON and hashing that would fail on any difference in key order, unicode
 * escaping or whitespace, so the caller must pass the untouched body.
 *
 * Fail-closed: a missing header, a malformed header, or an unset secret is a
 * rejection, never a pass. Both sides are hashed to a fixed 32 bytes before
 * comparing so timingSafeEqual cannot throw on a length mismatch and the
 * comparison stays constant-time regardless of what an attacker sends. This
 * mirrors src/app/api/cron/_guard.ts.
 */
export function verifyMetaSignature(
  rawBody: string,
  header: string | null | undefined,
  appSecret: string | undefined,
): boolean {
  if (!appSecret || !header) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  // Meta sends "sha256=<hex>". Compare the whole header, prefix included, so a
  // header naming a different algorithm can never match.
  const presentedDigest = createHash("sha256").update(header).digest();
  const expectedDigest = createHash("sha256").update(`sha256=${expected}`).digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

/* ---------- 2. Phone numbers ---------- */

/** E.164 allows at most 15 digits; anything shorter than 8 is not a mobile. */
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

/**
 * Canonical phone form: digits only, no "+", no spaces, no punctuation.
 *
 * Meta puts the sender in the payload as bare digits with the country code
 * ("6591234567"). An admin adding that number to the allowlist will type it
 * however they think of it: "+65 9123 4567", "9123-4567", "0065...". All of
 * those must land on the same key, or the allowlist silently fails to match
 * and a legitimate sender is treated as a stranger.
 *
 * `defaultCallingCode` (digits, e.g. "65") is prepended when the input is a
 * bare local number. It is passed in rather than read from env to keep this
 * function pure.
 */
export function normalisePhone(raw: string, defaultCallingCode = ""): string | null {
  if (typeof raw !== "string") return null;
  let digits = raw.replace(/\D+/g, "");
  if (!digits) return null;

  // "00" is the international access prefix in much of the world; "+" arrives
  // here already stripped. Both mean "the rest is a full E.164 number".
  const hadPlus = raw.trim().startsWith("+");
  if (!hadPlus && digits.startsWith("00")) digits = digits.slice(2);

  // A bare local number needs its country code. Only apply the default when
  // the number is too short to already carry one.
  const cc = defaultCallingCode.replace(/\D+/g, "");
  if (!hadPlus && cc && digits.length < MIN_DIGITS + cc.length && !digits.startsWith(cc)) {
    digits = cc + digits;
  }

  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;
  return digits;
}

/**
 * Mask a phone number for logs, audit records and error text.
 *
 * The full number is personal data and this system is under IM8, so nothing
 * that writes to a log or an audit row should carry it in full. Keeps the last
 * 4 digits, which is enough for staff to recognise a sender they know.
 */
export function maskPhone(digits: string): string {
  const d = digits.replace(/\D+/g, "");
  if (d.length <= 4) return "*".repeat(d.length);
  return `${"*".repeat(d.length - 4)}${d.slice(-4)}`;
}

/* ---------- 3. What did the sender ask for? ---------- */

export type Submission =
  | { kind: "url"; value: string }
  | { kind: "doi"; value: string }
  | { kind: "help" }
  | { kind: "empty" };

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;

/**
 * Characters that commonly trail a pasted link in prose but are not part of
 * it. Closing brackets are only stripped when unbalanced, so a Wikipedia-style
 * URL ending in ")" survives.
 */
function trimTrailingPunctuation(url: string): string {
  let out = url;
  for (;;) {
    const last = out.at(-1);
    if (!last) break;
    if (".,;:!?’'\"".includes(last)) {
      out = out.slice(0, -1);
      continue;
    }
    if (last === ")" || last === "]" || last === "}") {
      const open = last === ")" ? "(" : last === "]" ? "[" : "{";
      const opens = out.split(open).length - 1;
      const closes = out.split(last).length - 1;
      if (closes > opens) {
        out = out.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return out;
}

/**
 * Read a sender's message.
 *
 * Deliberately permissive about the surrounding text, because people paste a
 * link with a sentence around it. Deliberately strict about the scheme: only
 * http and https, so "javascript:", "file:", "data:" and friends can never
 * reach the fetcher. A bare "www." host is upgraded to https rather than
 * rejected, and a bare DOI is recognised because the metadata pipeline
 * (draftRecord) resolves those without any page fetch at all.
 */
export function parseSubmission(text: string | null | undefined): Submission {
  if (!text || typeof text !== "string") return { kind: "empty" };
  const trimmed = text.trim();
  if (!trimmed) return { kind: "empty" };

  const lower = trimmed.toLowerCase();
  if (lower === "help" || lower === "?" || lower === "hi" || lower === "hello") {
    return { kind: "help" };
  }

  // An explicit http(s) link wins: it is what the sender actually chose.
  const explicit = trimmed.match(/https?:\/\/[^\s<>"']+/i);
  if (explicit) {
    const url = trimTrailingPunctuation(explicit[0]);
    return isUsableHttpUrl(url) ? { kind: "url", value: url } : { kind: "empty" };
  }

  // A DOI resolves deterministically through Crossref, so prefer it over
  // guessing at a bare hostname.
  const doi = trimmed.match(DOI_RE);
  if (doi) return { kind: "doi", value: trimTrailingPunctuation(doi[1]) };

  const bare = trimmed.match(/\bwww\.[^\s<>"']+/i);
  if (bare) {
    const url = `https://${trimTrailingPunctuation(bare[0])}`;
    return isUsableHttpUrl(url) ? { kind: "url", value: url } : { kind: "empty" };
  }

  return { kind: "empty" };
}

/**
 * A URL this system is willing to fetch and store.
 *
 * Scheme and shape only. Whether the HOST is safe to reach is a separate
 * question answered by isBlockedHost in src/lib/net.ts, which the caller must
 * also apply; keeping the two apart means this stays pure.
 */
export function isUsableHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (!u.hostname) return false;
  // A hostname with no dot is either a local alias or a typo; either way it is
  // not a public resource an external submission should create a record for.
  if (!u.hostname.includes(".")) return false;
  // Credentials in a URL would be stored in the catalogue and handed to
  // learners. Refuse rather than silently strip.
  if (u.username || u.password) return false;
  return true;
}

/* ---------- 4. Reading Meta's webhook envelope ---------- */

export type InboundMessage = {
  /** Meta's message id (wamid...), used to make processing idempotent. */
  id: string;
  /** Sender in Meta's canonical form: digits, country code, no "+". */
  from: string;
  /** Text body, or null for a message type this bot does not handle. */
  text: string | null;
  /** The business number that received it, so a shared app can route. */
  phoneNumberId: string | null;
  /** Meta's unix-seconds timestamp, when parseable. */
  at: Date | null;
  /** Message type as Meta labels it (text, image, audio, reaction, …). */
  type: string;
};

/** Unknown-shape helper: read a property without trusting the shape. */
function get(o: unknown, key: string): unknown {
  return o && typeof o === "object" ? (o as Record<string, unknown>)[key] : undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/**
 * Pull inbound messages out of a Meta webhook payload.
 *
 * Written defensively on purpose. This parses a payload posted by an external
 * party, and even after the signature proves it came from Meta, the SHAPE is
 * not ours to assume: Meta adds message types and envelope fields over time,
 * and a single delivery can batch several entries and changes.
 *
 * Two things this must never do:
 *   - Throw. A crash on an unfamiliar payload turns into a 500, and Meta
 *     retries 500s, so one odd message would loop.
 *   - Mistake a STATUS callback for a message. Delivery receipts ("sent",
 *     "delivered", "read") arrive on the same webhook with `statuses` instead
 *     of `messages`; treating one as a submission would reply to every receipt
 *     and, since each reply generates its own receipt, never stop.
 *
 * Non-text messages are returned with text: null rather than dropped, so the
 * caller can answer a photo with a hint instead of silence.
 */
export function parseInboundMessages(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  if (get(payload, "object") !== "whatsapp_business_account") return out;

  for (const entry of arr(get(payload, "entry"))) {
    for (const change of arr(get(entry, "changes"))) {
      const value = get(change, "value");
      // Delivery receipts, not submissions.
      if (arr(get(value, "statuses")).length > 0) continue;
      const phoneNumberId = str(get(get(value, "metadata"), "phone_number_id"));

      for (const m of arr(get(value, "messages"))) {
        const id = str(get(m, "id"));
        const from = str(get(m, "from"));
        if (!id || !from) continue; // unusable without both
        const type = str(get(m, "type")) ?? "unknown";
        const tsRaw = get(m, "timestamp");
        const tsNum = typeof tsRaw === "string" ? Number(tsRaw) : typeof tsRaw === "number" ? tsRaw : NaN;
        out.push({
          id,
          from,
          // Only "text" carries a body this bot can act on. A caption on an
          // image is deliberately ignored: acting on it would mean storing a
          // link a sender may not have meant to submit.
          text: type === "text" ? str(get(get(m, "text"), "body")) : null,
          phoneNumberId,
          at: Number.isFinite(tsNum) && tsNum > 0 ? new Date(tsNum * 1000) : null,
          type,
        });
      }
    }
  }
  return out;
}

/* ---------- Reply text ---------- */

/** WhatsApp text bodies are capped well above this; keep replies readable. */
export const REPLY_MAX = 900;

/** Trim a reply to a length WhatsApp will accept, on a word boundary. */
export function clipReply(body: string): string {
  if (body.length <= REPLY_MAX) return body;
  const cut = body.slice(0, REPLY_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > REPLY_MAX * 0.6 ? cut.slice(0, space) : cut}…`;
}
