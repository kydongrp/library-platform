// Round-trip test for backup encryption: right key works, wrong key fails
// closed, tampering is detected.
import { encrypt, decrypt, isEncrypted } from "./lib/crypt";
let fails = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) fails++;
};
const plain = Buffer.from("member,email\nAisha,aisha@example.edu\n".repeat(50), "utf8");
const KEY = { BACKUP_KEY: "correct-horse-battery-staple-32ch" } as unknown as NodeJS.ProcessEnv;
const WRONG = { BACKUP_KEY: "wrong-horse-battery-staple-32chr" } as unknown as NodeJS.ProcessEnv;

const ct = encrypt(plain, KEY);
check(isEncrypted(ct), "ciphertext carries the magic header");
check(!ct.includes(Buffer.from("aisha@example.edu")), "plaintext email does not appear in ciphertext");
check(decrypt(ct, KEY).equals(plain), "round trip with the right key");

try { decrypt(ct, WRONG); check(false, "wrong key rejected"); }
catch (e) { check(/wrong BACKUP_KEY|damaged/.test((e as Error).message), "wrong key rejected with a clear message"); }

const tampered = Buffer.from(ct);
tampered[tampered.length - 30] ^= 0xff;
try { decrypt(tampered, KEY); check(false, "tampering detected"); }
catch { check(true, "tampering detected by the auth tag"); }

try { decrypt(plain, KEY); check(false, "plaintext rejected"); }
catch (e) { check(/Not an encrypted/.test((e as Error).message), "a plain file is not mistaken for ciphertext"); }

try { encrypt(plain, { BACKUP_KEY: "short" } as unknown as NodeJS.ProcessEnv); check(false, "short key rejected"); }
catch (e) { check(/too short/.test((e as Error).message), "a too-short key is refused"); }

console.log(fails === 0 ? "crypt suite passed" : `crypt suite FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
