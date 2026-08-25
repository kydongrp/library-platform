/**
 * How a notice actually leaves the building.
 *
 * Until now it did not. `notify()` wrote a MailQueue row with status SENT and
 * a comment saying the send was simulated, so the outbox reported success for
 * mail nobody received. Everything here exists to make that status true.
 *
 * The transport is an interface with two implementations because the choice is
 * not ours to make: KLSI may well mandate their own relay, and until they say
 * so the safe default is to send nothing. Selection is by environment variable,
 * so changing provider is configuration rather than a deploy.
 *
 * Nothing in this file talks to the database. The queue drains in queue.ts;
 * this layer only knows how to hand one message to one provider.
 */

/** A message ready to leave, already rendered from its template. */
export type OutgoingMail = {
  to: string;
  toName: string;
  subject: string;
  /** Plain text. Templates are authored as text and are not HTML. */
  body: string;
};

/**
 * The result of one attempt.
 *
 * `retryable` is the whole point of the type: a 500 from the provider deserves
 * another go in five minutes, and a malformed recipient deserves to stop
 * immediately rather than burn four more attempts and a day of backoff.
 */
export type SendOutcome =
  | { ok: true; providerId?: string }
  | { ok: false; error: string; retryable: boolean };

export interface MailTransport {
  /** Recorded on the row that this transport sent, so the outbox can say how. */
  readonly name: string;
  send(mail: OutgoingMail): Promise<SendOutcome>;
}

/** Trim, and treat an empty or whitespace-only variable as absent. */
function env(name: string): string | undefined {
  const raw = process.env[name];
  const value = raw?.trim();
  return value ? value : undefined;
}

/**
 * The provider that accepts a JSON POST and answers with a message id.
 *
 * Written against Resend's shape, which several providers copy, and pointed by
 * `MAIL_API_BASE` so it can be aimed at a different host or at a local stub in
 * a test without touching this code. HTTP rather than SMTP on purpose: a
 * serverless function holding an SMTP connection open is the least reliable
 * part of any deployment like this one.
 */
class HttpApiTransport implements MailTransport {
  readonly name: string;

  constructor(
    private readonly base: string,
    private readonly apiKey: string,
    private readonly from: string,
  ) {
    this.name = `http:${new URL(base).host}`;
  }

  async send(mail: OutgoingMail): Promise<SendOutcome> {
    // A recipient with a display name is friendlier, but a name containing a
    // quote or a comma would break the header, so it is only used when plain.
    const safeName = /^[\w .'-]{1,64}$/.test(mail.toName) ? mail.toName : "";
    const to = safeName ? `${safeName} <${mail.to}>` : mail.to;

    let response: Response;
    try {
      response = await fetch(`${this.base.replace(/\/+$/, "")}/emails`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: [to],
          subject: mail.subject,
          text: mail.body,
        }),
        // A hung provider must not hold the whole drain open.
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      // Network failure, DNS, or the timeout above. All worth another go.
      return { ok: false, error: describe(error), retryable: true };
    }

    if (response.ok) {
      const providerId = await response
        .json()
        .then((body: unknown) =>
          body && typeof body === "object" && "id" in body ? String(body.id) : undefined,
        )
        .catch(() => undefined);
      return { ok: true, providerId };
    }

    const detail = (await response.text().catch(() => "")).slice(0, 300);
    return {
      ok: false,
      error: `${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
      // 429 is rate limiting and 5xx is the provider's problem; both pass.
      // Everything else is our request being wrong, and repeating it will not
      // make it right.
      retryable: response.status === 429 || response.status >= 500,
    };
  }
}

/**
 * Accepts everything and sends nothing.
 *
 * This is what runs when no provider is configured, and it is deliberately a
 * transport rather than a special case in the drain: the queue exercises the
 * same code path in every environment, so the first real send is not also the
 * first time that path has run.
 */
class DryRunTransport implements MailTransport {
  readonly name = "dry-run";
  async send(): Promise<SendOutcome> {
    return { ok: true };
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? "Timed out after 15s" : error.message;
  }
  return String(error);
}

/**
 * The transport this deployment is configured for.
 *
 * Falls back to dry run when anything is missing, which is the safe direction:
 * a half-configured provider sends nothing rather than sending from the wrong
 * address or with a key that does not work.
 */
export function resolveTransport(): MailTransport {
  const apiKey = env("MAIL_API_KEY");
  const from = env("MAIL_FROM");
  if (!apiKey || !from) return new DryRunTransport();
  return new HttpApiTransport(env("MAIL_API_BASE") ?? "https://api.resend.com", apiKey, from);
}

/** Whether a real provider is configured, for the outbox to report. */
export function transportIsLive(): boolean {
  return resolveTransport().name !== "dry-run";
}
