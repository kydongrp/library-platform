// SFTP source adapter for the scheduled metadata-import service (SDD: vendor
// XML dropped via SFTP). All connection details come from environment
// variables — credentials never live in the database or the code. The client
// library is imported dynamically so it is only loaded when SFTP is actually
// configured and invoked (and never bundled into other routes).
import path from "node:path";

const SUPPORTED = /\.(xml|marcxml|mrcx|csv|tsv|json)$/i;
const READY_TIMEOUT_MS = 15_000;

export type SftpSourceInfo = {
  host: string;
  port: number;
  remoteDir: string;
  provider: string;
  defaultCategory: string;
  auth: "key" | "password";
};

/** True when enough env vars are set to attempt a connection. */
export function sftpConfigured(): boolean {
  const e = process.env;
  return Boolean(
    e.SFTP_HOST &&
      e.SFTP_USER &&
      (e.SFTP_PASSWORD || e.SFTP_PRIVATE_KEY) &&
      e.SFTP_PROVIDER,
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
    defaultCategory: e.SFTP_DEFAULT_CATEGORY || "Technology",
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
    // Env vars commonly store PEM keys with escaped newlines — restore them.
    cfg.privateKey = e.SFTP_PRIVATE_KEY.includes("\\n")
      ? e.SFTP_PRIVATE_KEY.replace(/\\n/g, "\n")
      : e.SFTP_PRIVATE_KEY;
    if (e.SFTP_PASSPHRASE) cfg.passphrase = e.SFTP_PASSPHRASE;
  } else {
    cfg.password = e.SFTP_PASSWORD!;
  }
  return cfg;
}

export type SftpFile = { filename: string; content: string };

export type SftpFetchResult = {
  files: SftpFile[]; // new files downloaded this run (capped)
  totalNew: number; // total new files seen before the cap
};

/**
 * Connect, list the remote directory, and download every supported file whose
 * name we have not already processed — up to `maxFiles`. Filenames are taken
 * from the server listing and reduced to their basename to avoid any path
 * traversal when re-joining to the remote directory.
 */
export async function fetchNewSftpFiles(
  processed: Set<string>,
  maxFiles: number,
): Promise<SftpFetchResult> {
  const { default: SftpClient } = await import("ssh2-sftp-client");
  const sftp = new SftpClient();
  const dir = process.env.SFTP_REMOTE_DIR || ".";

  await sftp.connect(connectConfig());
  try {
    const listing = await sftp.list(dir);
    const candidates = listing
      .filter((entry) => entry.type === "-") // regular files only
      .map((entry) => path.posix.basename(entry.name)) // strip any directory part
      .filter((name) => SUPPORTED.test(name) && !name.includes("/") && !name.includes(".."))
      .filter((name) => !processed.has(name))
      .sort();

    const chosen = candidates.slice(0, maxFiles);
    const files: SftpFile[] = [];
    for (const name of chosen) {
      const buf = (await sftp.get(path.posix.join(dir, name))) as Buffer;
      files.push({ filename: name, content: buf.toString("utf8") });
    }
    return { files, totalNew: candidates.length };
  } finally {
    await sftp.end().catch(() => {});
  }
}
