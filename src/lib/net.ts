// Shared network-safety helpers for server-side fetches of user- or
// vendor-supplied URLs (link checker, AI draft page fetch, resource intake).
//
// Read this before trusting any of it: a HOSTNAME check cannot stop SSRF. It
// cannot see an A record, so "ssrf.example.com" pointing at 169.254.169.254
// passes every string rule here. The functions below are a cheap first filter
// that rejects the obvious and the accidental; the actual defence is the DNS
// lookup hook in src/lib/page-fetch.ts, which validates the resolved ADDRESS
// and hands the socket that same address, leaving no rebinding window.
//
// Callers doing their own fetching should use fetchGuardedPage rather than
// pairing these with a bare fetch().

/**
 * Address ranges a server-side fetcher must never reach: loopback, private,
 * link-local (which includes the cloud metadata endpoints), CGNAT, multicast
 * and reserved space.
 *
 * Takes a resolved IP, not a hostname, so this is the check with teeth.
 */
export function isBlockedAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (!addr) return true;

  const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    const octets = [+v4[1], +v4[2], +v4[3], +v4[4]];
    if (octets.some((o) => o > 255)) return true; // not a real address
    if (a === 0) return true; // 0.0.0.0/8, "this host on this network"
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol assignments, 192.0.2.0/24 TEST-NET
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  if (!addr.includes(":")) return true; // neither v4 nor v6: refuse

  // IPv4-mapped and IPv4-compatible IPv6, in dotted form: ::ffff:127.0.0.1
  const mapped = addr.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedAddress(mapped[1]);

  // The same thing in hex form: ::ffff:7f00:1 is 127.0.0.1
  const mappedHex = addr.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }

  if (addr === "::1" || addr === "::") return true; // loopback, unspecified
  if (/^f[cd][0-9a-f]{0,2}:/.test(addr)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]?:/.test(addr)) return true; // fe80::/10 link-local
  if (/^ff[0-9a-f]{0,2}:/.test(addr)) return true; // ff00::/8 multicast
  return false;
}

/**
 * Rewrite a non-dotted-quad IPv4 literal into a dotted quad, or return null.
 *
 * Browsers and most resolvers accept inet_aton forms: "2130706433",
 * "0x7f000001", "0177.0.0.1" and "127.1" are all 127.0.0.1. A naive blocklist
 * that only matches "127.0.0.1" waves all four straight through.
 */
export function normaliseIpv4Literal(host: string): string | null {
  const parts = host.split(".");
  if (parts.length === 0 || parts.length > 4) return null;

  const nums: number[] = [];
  for (const raw of parts) {
    if (raw === "") return null;
    let n: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(raw)) n = parseInt(raw.slice(2), 16);
    else if (/^0[0-7]+$/.test(raw)) n = parseInt(raw.slice(1), 8);
    else if (/^\d+$/.test(raw)) n = parseInt(raw, 10);
    else return null; // contains letters: a real hostname, not a literal
    if (!Number.isSafeInteger(n) || n < 0) return null;
    nums.push(n);
  }

  // inet_aton: the final part absorbs all remaining low-order bytes, so
  // "127.1" is 127.0.0.1 and "2130706433" is the whole 32-bit value.
  const fill = 4 - nums.length;
  const last = nums.pop();
  if (last === undefined) return null;
  if (last > 256 ** (fill + 1) - 1) return null;
  if (nums.some((n) => n > 255)) return null;

  const bytes = [...nums];
  for (let i = fill; i >= 0; i--) bytes.push((last >>> (8 * i)) & 255);
  return bytes.join(".");
}

/**
 * Hostnames refused before any DNS lookup happens.
 *
 * A cheap first filter only. Everything real is caught by the address check
 * after resolution.
 */
export function isBlockedHostname(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "metadata.google.internal") return true;
  // Names that only resolve inside a private network.
  for (const suffix of [".internal", ".local", ".localdomain", ".home.arpa", ".onion"]) {
    if (host.endsWith(suffix)) return true;
  }

  // Bracketed or bare IPv6, and dotted-quad IPv4.
  if (host.includes(":")) return isBlockedAddress(host);
  if (/^[0-9.]+$/.test(host) || /^0[xX][0-9a-fA-F.]+$/.test(host)) {
    const dotted = normaliseIpv4Literal(host);
    // A numeric host we cannot parse is refused rather than guessed at.
    return dotted ? isBlockedAddress(dotted) : true;
  }
  return false;
}

/**
 * Block obvious SSRF targets before the server fetches a URL.
 *
 * Kept as the entry point the existing callers already use. It guards the
 * hostname only: it does not resolve DNS, chase redirects, or restrict ports.
 * Use fetchGuardedPage (src/lib/page-fetch.ts) for anything that actually
 * opens a socket.
 */
export function isBlockedHost(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return true;
  }
  return isBlockedHostname(host);
}
