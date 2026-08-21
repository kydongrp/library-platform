/**
 * Take a logical backup of the database in DATABASE_URL.
 *
 *   npx tsx --env-file=.env scripts/backup.ts [outDir]
 *
 * Writes <outDir>/dls-backup-<timestamp>.ndjson.gz (default outDir: ./backups,
 * which is git-ignored — the repo is public and these rows are personal data).
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { backup, connectionString, describeTarget } from "./lib/dump";
import { hasBackupKey } from "./lib/crypt";

void (async () => {
  const outDir = resolve(process.argv[2] ?? "backups");
  mkdirSync(outDir, { recursive: true });

  const url = connectionString();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Name the file for what it actually is: an .enc that anyone treats as gzip
  // wastes time, and a .gz that is really ciphertext is worse.
  const ext = hasBackupKey() ? "ndjson.gz.enc" : "ndjson.gz";
  const path = resolve(outDir, `dls-backup-${stamp}.${ext}`);

  console.log(`Backing up ${describeTarget(url)}`);
  const { manifest, bytes, encrypted } = await backup(path, url);
  const kb = (bytes / 1024).toFixed(1);
  console.log(`OK  ${manifest.totalRows} rows across ${manifest.tableOrder.length} tables -> ${path} (${kb} KB)`);
  console.log(encrypted
    ? "    ENCRYPTED with BACKUP_KEY (AES-256-GCM). Keep that key somewhere the backup is not."
    : "    NOT ENCRYPTED — set BACKUP_KEY before this file leaves the machine; it holds member names and emails.");
  const nonEmpty = Object.entries(manifest.rowCounts).filter(([, n]) => n > 0);
  console.log(`    ${nonEmpty.length} non-empty tables, server ${manifest.serverVersion}`);
})();
