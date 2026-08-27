/**
 * WhatsApp Cloud API: the I/O half of the submission bot. Server-only.
 *
 * The pure decisions (signature, phone normalisation, message parsing) live in
 * src/lib/whatsapp-core.ts and are tested there. This module only talks to
 * Meta.
 *
 * Configuration, all optional. Unset = the feature is OFF and the webhook
 * refuses every request rather than running anonymously, matching how
 * src/app/api/cron/_guard.ts treats a missing CRON_SECRET:
 *
 *   WHATSAPP_APP_SECRET        Meta app secret. Verifies X-Hub-Signature-256
 *                              on inbound webhooks. Without it nothing inbound
 *                              is trusted, so the webhook returns 503.
 *   WHATSAPP_VERIFY_TOKEN      Shared string echoed during Meta's one-time
 *                              webhook verification handshake.
 *   WHATSAPP_ACCESS_TOKEN      Graph API bearer token for sending replies.
 *   WHATSAPP_PHONE_NUMBER_ID   The business number that sends replies.
 *   WHATSAPP_GRAPH_VERSION     Graph API version, default below. Pinned rather
 *                              than floating: Meta deprecates versions on a
 *                              schedule and a silent bump changes behaviour.
 *   WHATSAPP_CALLING_CODE      Default country calling code (digits) used when
 *                              an admin types a local number into the sender
 *                              allowlist. "65" for Singapore.
 *
 * The repo is PUBLIC, so none of these may ever be committed. They live in
 * .env locally and in Vercel's environment for production.
 */
import { maskPhone } from "@/lib/whatsapp-core";

/** Pinned deliberately. Bump only after checking Meta's changelog. */
const DEFAULT_GRAPH_VERSION = "v23.0";

const SEND_TIMEOUT_MS = 10_000;

export function whatsappInboundConfigured(): boolean {
  return !!process.env.WHATSAPP_APP_SECRET && !!process.env.WHATSAPP_VERIFY_TOKEN;
}

export function whatsappSendConfigured(): boolean {
  return !!process.env.WHATSAPP_ACCESS_TOKEN && !!process.env.WHATSAPP_PHONE_NUMBER_ID;
}

/** Both halves working is what "the bot is live" means. */
export function whatsappConfigured(): boolean {
  return whatsappInboundConfigured() && whatsappSendConfigured();
}

export function whatsappCallingCode(): string {
  return (process.env.WHATSAPP_CALLING_CODE ?? "").replace(/\D+/g, "");
}

function graphVersion(): string {
  const v = (process.env.WHATSAPP_GRAPH_VERSION ?? "").trim();
  return /^v\d+\.\d+$/.test(v) ? v : DEFAULT_GRAPH_VERSION;
}

export type SendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; error: string; outsideWindow: boolean };

/**
 * Meta's error code for "no open customer service window", i.e. the business
 * tried to send a free-form message more than 24 hours after the user's last
 * message. Worth distinguishing because it is not a fault: it means the sender
 * has gone quiet and the reply should be dropped, not retried.
 */
const OUTSIDE_WINDOW_CODES = new Set([131047, 131051, 470]);

/**
 * Send a plain text WhatsApp message.
 *
 * Only ever called in reply to an inbound message, which is what keeps this
 * inside Meta's 24-hour customer service window where free-form (non-template)
 * text is allowed. Nothing in this system initiates a WhatsApp conversation.
 *
 * Never throws: the caller is a webhook that must still return 200 so Meta
 * does not retry a message that was already processed. Failures are returned.
 */
export async function sendWhatsAppText(
  to: string,
  body: string,
  opts: { replyToMessageId?: string; previewUrl?: boolean } = {},
): Promise<SendResult> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    return { ok: false, error: "WhatsApp sending is not configured.", outsideWindow: false };
  }

  const payload: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    // preview_url lets WhatsApp render a link card for the URL in the reply,
    // which is the point of replying with a link at all.
    text: { body, preview_url: opts.previewUrl ?? true },
  };
  // Quoting the sender's own message makes a threaded conversation readable
  // when someone submits several links in a row.
  if (opts.replyToMessageId) payload.context = { message_id: opts.replyToMessageId };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: {
          // The token is a bearer secret. It is never logged, and error text
          // below is built from Meta's message only.
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: "error",
      },
    );

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Meta returned something that is not JSON; the status still tells us.
    }

    if (!res.ok) {
      const err =
        parsed && typeof parsed === "object"
          ? ((parsed as { error?: { message?: string; code?: number } }).error ?? {})
          : {};
      const code = typeof err.code === "number" ? err.code : 0;
      return {
        ok: false,
        error: `Meta returned ${res.status}${err.message ? `: ${err.message}` : ""}`,
        outsideWindow: OUTSIDE_WINDOW_CODES.has(code),
      };
    }

    const messages = (parsed as { messages?: { id?: string }[] } | null)?.messages;
    return { ok: true, messageId: messages?.[0]?.id ?? null };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    // maskPhone keeps the recipient out of logs: this string may be audited.
    return {
      ok: false,
      error: aborted
        ? `Timed out after ${SEND_TIMEOUT_MS}ms sending to ${maskPhone(to)}`
        : `Send failed for ${maskPhone(to)}: ${e instanceof Error ? e.message : "unknown error"}`,
      outsideWindow: false,
    };
  } finally {
    clearTimeout(timer);
  }
}
