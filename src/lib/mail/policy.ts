/**
 * Whether a given notice is allowed to leave, decided before any provider is
 * contacted.
 *
 * This file exists because the failure that matters here is not "mail did not
 * send". It is a preview deployment, or a developer's laptop, mailing 11 real
 * library members an overdue notice for a loan that only exists in test data.
 * Every rule below fails closed for that reason.
 */

export type MailDisposition =
  | { send: true }
  | { send: false; reason: string };

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function truthy(name: string): boolean {
  const value = env(name)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/** Attempts before a message is abandoned as FAILED. */
export const MAX_ATTEMPTS = 5;

/**
 * Backoff between attempts, in minutes, indexed by the attempt just made.
 *
 * Front-loaded because most failures are transient and clear within minutes,
 * then long, because a message still failing after two hours is usually
 * failing for a reason that another five minutes will not fix.
 */
const BACKOFF_MINUTES = [5, 30, 120, 720];

export function nextAttemptAfter(attempts: number, now: Date): Date {
  const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1] ?? 720;
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * How long a message may wait before it is abandoned rather than sent.
 *
 * A queue that has been stopped for a week must not empty itself the moment
 * someone fixes it: a member receiving Monday's due-soon reminder on Friday is
 * worse than not receiving it, and forty of them at once is worse again.
 */
export function maxAgeHours(): number {
  const raw = Number(env("MAIL_MAX_AGE_HOURS") ?? "72");
  return Number.isFinite(raw) && raw > 0 ? raw : 72;
}

/**
 * Whether this deployment may send at all.
 *
 * Three conditions, all required:
 *
 *   1. MAIL_ENABLED is explicitly on. Opt in, never opt out, so a new
 *      environment starts silent.
 *   2. This is not a Preview deployment. Previews are built from unreviewed
 *      branches against whatever database they are pointed at, and no branch
 *      should be able to mail a member. This is not negotiable by variable.
 *   3. A provider is configured, which resolveTransport() enforces separately.
 */
export function sendingEnabled(): { enabled: boolean; reason?: string } {
  if (process.env.VERCEL_ENV === "preview") {
    return { enabled: false, reason: "Preview deployments never send mail." };
  }
  if (!truthy("MAIL_ENABLED")) {
    return { enabled: false, reason: "MAIL_ENABLED is not set, so nothing is sent." };
  }
  return { enabled: true };
}

/**
 * The allowlist, parsed. Entries are either a whole address or a domain
 * written with a leading @, both matched case-insensitively.
 *
 * When it is set, everything not on it is suppressed. This is how a staging
 * environment is pointed at a real provider without any risk to real members:
 * set it to the team's own addresses and nothing else can be reached.
 */
export function allowlist(): string[] {
  const raw = env("MAIL_ALLOWLIST");
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function allowed(address: string, entries: string[]): boolean {
  const target = address.trim().toLowerCase();
  return entries.some((entry) =>
    entry.startsWith("@") ? target.endsWith(entry) : target === entry,
  );
}

/**
 * A recipient address that a provider will accept.
 *
 * Deliberately not a full RFC 5322 parser. It rejects the shapes that reach a
 * provider and come back as a hard bounce, which is what would otherwise cost
 * five attempts and half a day of backoff to discover.
 */
export function looksLikeAnAddress(address: string): boolean {
  const value = address.trim();
  if (value.length < 3 || value.length > 254) return false;
  if (/\s/.test(value)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(value);
}

/** Whether this specific message may be sent right now. */
export function dispositionFor(toEmail: string): MailDisposition {
  const enabled = sendingEnabled();
  if (!enabled.enabled) return { send: false, reason: enabled.reason ?? "Sending is disabled." };

  if (!looksLikeAnAddress(toEmail)) {
    return { send: false, reason: `Not a usable address: ${toEmail}` };
  }

  const entries = allowlist();
  if (entries.length > 0 && !allowed(toEmail, entries)) {
    return { send: false, reason: "Recipient is not on MAIL_ALLOWLIST." };
  }

  return { send: true };
}

/** How many messages one drain may attempt, so a run stays inside its budget. */
export function batchSize(): number {
  const raw = Number(env("MAIL_BATCH_SIZE") ?? "25");
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 200) : 25;
}
