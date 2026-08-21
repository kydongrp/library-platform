/**
 * Backup encryption.
 *
 * A dump is a file full of member names and emails. Once it leaves the
 * database it must be ciphertext, so that whatever holds it — a laptop, an
 * object store, a CI runner — never sees personal data. Encrypting at the
 * source is also what makes an offsite copy defensible: the storage provider
 * holds bytes it cannot read.
 *
 * AES-256-GCM (authenticated, so tampering is detected on restore) with the
 * key derived by scrypt from BACKUP_KEY. Node built-ins only.
 *
 * File layout:
 *   magic "DLSBK1\0" | salt(16) | iv(12) | ciphertext… | authTag(16)
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";

export const MAGIC = Buffer.from("DLSBK1\0", "latin1");
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/**
 * scrypt cost: deliberately slow enough to matter against a stolen file.
 * N=2^15 with r=8 needs ~32MB, which is exactly Node's default maxmem, so
 * the ceiling has to be raised or derivation throws
 * ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
 */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

export function hasBackupKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.BACKUP_KEY && env.BACKUP_KEY.length > 0;
}

function requireKey(env: NodeJS.ProcessEnv = process.env): string {
  const k = env.BACKUP_KEY;
  if (!k) throw new Error("BACKUP_KEY is not set.");
  if (k.length < 16)
    throw new Error("BACKUP_KEY is too short; use at least 16 characters (32+ recommended).");
  return k;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, SCRYPT);
}

export function encrypt(plain: Buffer, env: NodeJS.ProcessEnv = process.env): Buffer {
  const passphrase = requireKey(env);
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, body, cipher.getAuthTag()]);
}

export function isEncrypted(buf: Buffer): boolean {
  return buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

export function decrypt(buf: Buffer, env: NodeJS.ProcessEnv = process.env): Buffer {
  if (!isEncrypted(buf)) throw new Error("Not an encrypted DLS backup.");
  const passphrase = requireKey(env);
  let off = MAGIC.length;
  const salt = buf.subarray(off, (off += SALT_LEN));
  const iv = buf.subarray(off, (off += IV_LEN));
  const tag = buf.subarray(buf.length - TAG_LEN);
  const body = buf.subarray(off, buf.length - TAG_LEN);
  const d = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    // GCM fails closed: a wrong key and a corrupted file are the same error.
    throw new Error("Could not decrypt: wrong BACKUP_KEY, or the file is damaged.");
  }
}
