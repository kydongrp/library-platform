// Shared network-safety helpers for server-side fetches of user- or
// vendor-supplied URLs (link checker, AI draft page fetch).

/**
 * Block obvious SSRF targets before the server fetches a URL: private,
 * loopback, link-local, CGNAT, and cloud-metadata hosts. Guards the initial
 * host only — it does not chase DNS rebinding or redirects into an internal
 * network, so callers should also disable or bound redirects where possible.
 */
export function isBlockedHost(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return true;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal")
    return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = +v4[1], b = +v4[2];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  if (host === "::1" || host === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith("fe80:")) return true; // ULA / link-local
  return false;
}
