// SFTP source adapter for the scheduled metadata-import service (SDD: vendor
// XML dropped via SFTP). All connection details come from environment
// variables; credentials never live in the database or the code. The client
// library is imported dynamically so it is only loaded when SFTP is actually
// configured and invoked (and never bundled into other routes).
import path from "node:path";

const SUPPORTED = /\.(xml|marcxml|mrcx|csv|tsv|json)$/i;
const READY_TIMEOUT_MS = 15_000; // connect/handshake
const LIST_TIMEOUT_MS = 15_000; // directory listing
const GET_TIMEOUT_MS = 30_000; // per-file download
const MAX_FILE_BYTES = 40 * 1024 * 1024; // skip any single file larger than this
const MAX_TOTAL_BYTES = 120 * 1024 * 1024; // stop the run once this much is buffered

export type SftpSourceInfo = {
  host: string;
  port: number;
  remoteDir: string;
  provider: string;
  defaultType: string;
  auth: "key" | "password";
};

/** True when enough env vars are set to attempt a connection. */
export function sftpConfigured(): boolean {
  const e = process.env;
  return Boolean(
    e.SFTP_HOST && e.SFTP_USER && (e.SFTP_PASSWORD || e.SFTP_PRIVATE_KEY) && e.SFTP_PROVIDER,
  );
}

/** Non-secret summary for display in the admin panel (never returns creds). */
export function sftpSourceInfo(): SftpSourceInfo | null {
  if (!sftpConfigured()) return null;
  const e = process.env;
  return {
    host: e.SFTP_HOST!,
    port: e.SFTP_PORT ? parseInt(e.SFTP_PORT, 10) : 22,
    remoteDir: e.SFTP_REMOTE_DIR || ".",
    provider: e.SFTP_PROVIDER!,
    defaultType: e.SFTP_DEFAULT_TYPE || "EBOOK",
    auth: e.SFTP_PRIVATE_KEY ? "key" : "password",
  };
}

type ConnectConfig = {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  readyTimeout: number;
};

function connectConfig(): ConnectConfig {
  const e = process.env;
  const cfg: ConnectConfig = {
    host: e.SFTP_HOST!,
    port: e.SFTP_PORT ? parseInt(e.SFTP_PORT, 10) : 22,
    username: e.SFTP_USER!,
    readyTimeout: READY_TIMEOUT_MS,
  };
  if (e.SFTP_PRIVATE_KEY) {
    // Env vars commonly store PEM keys with escaped newlines; restore them.
    cfg.privateKey = e.SFTP_PRIVATE_KEY.includes("\\n")
      ? e.SFTP_PRIVATE_KEY.replace(/\\n/g, "\n")
      : e.SFTP_PRIVATE_KEY;
    if (e.SFTP_PASSPHRASE) cfg.passphrase = e.SFTP_PASSPHRASE;
  } else {
    cfg.password = e.SFTP_PASSWORD!;
  }
  return cfg;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`SFTP ${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export type ProcessedInfo = Map<string, { mtime: number | null; size: number | null }>;

export type SftpFile = { filename: string; content: string; mtime: number | null; size: number | null };

export type SftpFetchResult = {
  files: SftpFile[]; // new/changed files downloaded this run (within caps)
  totalNew: number; // new/changed files seen before the file/byte caps
  oversize: { filename: string; size: number | null; mtime: number | null }[]; // skipped for exceeding MAX_FILE_BYTES
};

/**
 * Connect, list the remote directory, and download every supported file that
 * is new, or whose size/mtime changed since we last processed it, up to
 * `maxFiles` and a cumulative byte budget. Filenames are reduced to their
 * basename to prevent path traversal when re-joining to the remote directory.
 * A file larger than MAX_FILE_BYTES is never downloaded (returned in
 * `oversize` so the caller can record it and avoid re-fetching it every run).
 */
export async function fetchNewSftpFiles(
  processed: ProcessedInfo,
  maxFiles: number,
): Promise<SftpFetchResult> {
  const { default: SftpClient } = await import("ssh2-sftp-client");
  const sftp = new SftpClient();
  const dir = process.env.SFTP_REMOTE_DIR || ".";

  await sftp.connect(connectConfig());
  try {
    const listing = await withTimeout(sftp.list(dir), LIST_TIMEOUT_MS, "list");

    const changed = listing
      .filter((entry) => entry.type === "-") // regular files only
      .map((entry) => ({
        name: path.posix.basename(entry.name), // strip any directory part
        size: typeof entry.size === "number" ? entry.size : null,
        mtime: typeof entry.modifyTime === "number" ? entry.modifyTime : null,
      }))
      .filter((e) => SUPPORTED.test(e.name) && !e.name.includes("/") && !e.name.includes(".."))
      .filter((e) => {
        const prev = processed.get(e.name);
        if (!prev) return true; // never seen
        return prev.mtime !== e.mtime || prev.size !== e.size; // content refreshed under same name
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const oversize: SftpFetchResult["oversize"] = [];
    const files: SftpFile[] = [];
    let totalBytes = 0;
    let picked = 0;
    for (const e of changed) {
      if (picked >= maxFiles) break;
      if (e.size != null && e.size > MAX_FILE_BYTES) {
        oversize.push({ filename: e.name, size: e.size, mtime: e.mtime });
        picked++; // counts against the run so we make progress and record it
        continue;
      }
      if (e.size != null && totalBytes + e.size > MAX_TOTAL_BYTES && files.length > 0) break;
      const buf = (await withTimeout(
        sftp.get(path.posix.join(dir, e.name)),
        GET_TIMEOUT_MS,
        `download ${e.name}`,
      )) as Buffer;
      totalBytes += buf.length;
      files.push({ filename: e.name, content: buf.toString("utf8"), mtime: e.mtime, size: e.size });
      picked++;
    }

    return { files, totalNew: changed.length, oversize };
  } finally {
    await sftp.end().catch(() => {});
  }
}
