/**
 * Learner-portal sign-in credentials for a member. Server-only.
 *
 * The plaintext is never stored, never logged and never returned. What is kept
 * is scrypt(password, per-member salt), which is the same primitive the backup
 * tooling already uses (scripts/lib/crypt.ts) with parameters chosen for
 * interactive verification rather than key derivation for encryption.
 *
 * Scope, stated plainly: this stores and verifies a credential. It does NOT
 * make the learner portal use it. The portal is a separate system that
 * authenticates its own users today, and pointing it at this hash is a change
 * on that side. Until then, setting a password here records one for a member
 * without changing how they sign in anywhere.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "crypto";
import { promisify } from "util";

// promisify loses scrypt's options overload, so the shape is restated here.
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Interactive-login cost. N=2^15 is roughly 100ms on a server core, which is
 * slow enough to matter to an attacker and fast enough at a sign-in prompt.
 * maxmem must be passed explicitly: N=2^15 exceeds Node's 32MB default and
 * throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS without it.
 */
const PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;
const KEY_LEN = 64;
const SALT_LEN = 16;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

/**
 * A stored hash is self-describing so the parameters can change later without
 * invalidating everyone's password: scrypt$N$r$p$salt$key, all base64url.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(plain.normalize("NFKC"), salt, KEY_LEN, PARAMS);
  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

/** Verify a password against a stored hash. Never throws on a malformed hash. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const [scheme, n, r, p, saltB64, keyB64] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64url");
    const expected = Buffer.from(keyB64, "base64url");
    const key = await scrypt(plain.normalize("NFKC"), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: PARAMS.maxmem,
    });
    // Lengths already match by construction, but a truncated stored hash would
    // otherwise make timingSafeEqual throw rather than return false.
    if (key.length !== expected.length) return false;
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

export type PasswordProblem = string | null;

/**
 * Whether a proposed password is acceptable. Pure, so it is testable.
 *
 * Length is the only rule enforced, deliberately. Composition rules (an upper,
 * a digit, a symbol) push people towards predictable substitutions and are not
 * recommended by NIST SP 800-63B; length is what actually helps. The obvious
 * choices are refused outright instead.
 */
const OBVIOUS = new Set([
  "password", "password1", "passw0rd", "12345678", "123456789", "1234567890",
  "qwertyuiop", "letmein123", "welcome123", "iloveyou1", "administrator",
]);

export function checkPassword(plain: string, context: { email?: string; name?: string } = {}): PasswordProblem {
  const p = plain.normalize("NFKC");
  if (p.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (p.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (p.trim().length === 0) return "A password cannot be only spaces.";
  if (OBVIOUS.has(p.toLowerCase())) return "That password is too easy to guess.";
  const local = context.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && p.toLowerCase().includes(local)) {
    return "Do not use the email address in the password.";
  }
  if (context.name && context.name.length >= 4 && p.toLowerCase().includes(context.name.toLowerCase())) {
    return "Do not use the member's name in the password.";
  }
  return null;
}
