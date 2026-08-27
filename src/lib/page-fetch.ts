/**
 * Guarded page fetch for user-supplied URLs. Server-only.
 *
 * Built on node:http/node:https rather than global fetch for one reason: these
 * accept a `lookup` option, so the DNS result can be inspected BEFORE a packet
 * leaves, and the socket then connects to exactly the address that was
 * inspected. That closes the gap a hostname blocklist cannot:
 *
 *   ssrf.example.com.  A  169.254.169.254
 *
 * passes isUsableHttpUrl (https, has a dot, no credentials) and isBlockedHost
 * (not a literal, no blocked suffix), and would happily fetch the cloud
 * metadata endpoint. Checking the resolved address is the only thing that
 * stops it, and checking it inside the lookup hook is what stops the check
 * being separated from the connect (DNS rebinding).
 *
 * Redirects are chased by hand so every hop is re-validated. Letting the agent
 * follow them would revalidate nothing: hop 1 to a public host, hop 2 to
 * 169.254.169.254.
 */
import dns from "node:dns";
import type { LookupFunction } from "node:net";
import http from "node:http";
import https from "node:https";
import { isBlockedAddress, isBlockedHost } from "@/lib/net";
import { isUsableHttpUrl } from "@/lib/submission-core";

export const PAGE_BYTES_MAX = 512 * 1024;
export const HOP_TIMEOUT_MS = 8_000;
export const TOTAL_TIMEOUT_MS = 15_000;
export const MAX_HOPS = 3;

/** Ports a public web page is served on. Anything else is a service probe. */
const ALLOWED_PORTS = new Set(["", "80", "443"]);

/** Only these are parsed for metadata; a PDF or image is not worth decoding. */
const PARSEABLE_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "application/xml",
  "text/xml",
];

export type FetchFailure =
  | "blocked"
  | "scheme"
  | "port"
  | "timeout"
  | "too-many-hops"
  | "network"
  | "status"
  | "content-type"
  | "no-location";

export type GuardedPage =
  | {
      ok: true;
      body: string;
      contentType: string;
      finalUrl: string;
      hops: number;
      truncated: boolean;
    }
  | { ok: false; reason: FetchFailure; finalUrl: string; status?: number };

/**
 * DNS hook that refuses to hand the socket a private address.
 *
 * Every resolved address must pass, not just the first, so a mixed A-record
 * set cannot be raced. An error from here aborts the request before connect.
 */
const guardedLookup: LookupFunction = (hostname, options, cb) => {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addrs) => {
    // LookupFunction types `address` as required, but Node's lookupAndConnect
    // checks `err` first and ignores the address, so "" is safe here.
    if (err) return cb(err, "");
    const list = (Array.isArray(addrs) ? addrs : [addrs]) as dns.LookupAddress[];
    if (list.length === 0) {
      return cb(Object.assign(new Error("SSRF_NO_ADDRESS"), { code: "ENOTFOUND" }), "");
    }
    for (const a of list) {
      if (isBlockedAddress(a.address)) {
        return cb(Object.assign(new Error("SSRF_BLOCKED_ADDRESS"), { code: "EACCES" }), "");
      }
    }
    // Honour the caller's shape: `all` wants the list, otherwise one address.
    if (options.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
};

/**
 * Whether a URL may be requested at all. Pure, so it is testable.
 *
 * Scheme and shape (isUsableHttpUrl), then host safety (isBlockedHost), then
 * port. The DNS check happens later, in the lookup hook.
 */
export function admitUrl(
  raw: string,
): { ok: true } | { ok: false; reason: "scheme" | "blocked" | "port" } {
  if (!isUsableHttpUrl(raw)) return { ok: false, reason: "scheme" };
  if (isBlockedHost(raw)) return { ok: false, reason: "blocked" };
  let port = "";
  try {
    port = new URL(raw).port;
  } catch {
    return { ok: false, reason: "scheme" };
  }
  if (!ALLOWED_PORTS.has(port)) return { ok: false, reason: "port" };
  return { ok: true };
}

/** Decide where a redirect goes, or why it must stop. Pure, so it is testable. */
export function nextHop(
  location: string | null | undefined,
  currentUrl: string,
  hopsUsed: number,
  maxHops = MAX_HOPS,
): { kind: "follow"; url: string } | { kind: "stop"; reason: FetchFailure } {
  if (!location) return { kind: "stop", reason: "no-location" };
  if (hopsUsed >= maxHops) return { kind: "stop", reason: "too-many-hops" };
  let resolved: string;
  try {
    // Relative Location headers are legal and common.
    resolved = new URL(location, currentUrl).toString();
  } catch {
    return { kind: "stop", reason: "scheme" };
  }
  const admitted = admitUrl(resolved);
  if (!admitted.ok) return { kind: "stop", reason: admitted.reason };
  return { kind: "follow", url: resolved };
}

/** Pick a decoder label from a Content-Type, defaulting to utf-8. */
export function charsetOf(contentType: string): string {
  const m = contentType.match(/charset\s*=\s*"?([\w-]+)"?/i);
  return m ? m[1].toLowerCase() : "utf-8";
}

function decode(buf: Buffer, label: string): string {
  try {
    return new TextDecoder(label, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
}

type HopResult =
  | { kind: "body"; buf: Buffer; contentType: string; truncated: boolean }
  | { kind: "redirect"; location: string | null }
  | { kind: "fail"; reason: FetchFailure; status?: number };

/** One request. Never throws; every outcome is a HopResult. */
function requestOnce(
  url: string,
  deadline: number,
  userAgent: string,
  accept: string,
): Promise<HopResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: HopResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    const budget = Math.min(HOP_TIMEOUT_MS, Math.max(1, deadline - Date.now()));

    let req: http.ClientRequest;
    try {
      req = mod.request(
        url,
        {
          method: "GET",
          // agent: false forces a fresh connection, so a pooled socket opened
          // to a different address can never be reused for this request.
          agent: false,
          lookup: guardedLookup,
          headers: {
            "User-Agent": userAgent,
            Accept: accept,
            // A compressed body would have to be inflated before the size cap
            // could mean anything, so ask for none.
            "Accept-Encoding": "identity",
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            const loc = res.headers.location;
            res.destroy();
            return done({
              kind: "redirect",
              location: Array.isArray(loc) ? loc[0] : (loc ?? null),
            });
          }
          if (status < 200 || status >= 300) {
            res.destroy();
            return done({ kind: "fail", reason: "status", status });
          }

          const contentType = String(res.headers["content-type"] ?? "");
          const bare = contentType.split(";")[0].trim().toLowerCase();
          if (!PARSEABLE_TYPES.includes(bare)) {
            res.destroy();
            return done({ kind: "fail", reason: "content-type", status });
          }

          const chunks: Buffer[] = [];
          let total = 0;
          let truncated = false;
          res.on("data", (c: Buffer) => {
            const room = PAGE_BYTES_MAX - total;
            if (c.length >= room) {
              truncated = true;
              if (room > 0) chunks.push(c.subarray(0, room));
              total = PAGE_BYTES_MAX;
              res.destroy();
              return;
            }
            chunks.push(c);
            total += c.length;
          });
          // A destroy triggered by the size cap fires "close", not "end", so
          // both must settle or a truncated page would hang until the timeout.
          const finish = () =>
            done({ kind: "body", buf: Buffer.concat(chunks), contentType, truncated });
          res.on("end", finish);
          res.on("close", finish);
          res.on("error", () => done({ kind: "fail", reason: "network", status }));
        },
      );
    } catch {
      return done({ kind: "fail", reason: "network" });
    }

    req.setTimeout(budget, () => {
      req.destroy();
      done({ kind: "fail", reason: "timeout" });
    });
    req.on("error", (e: NodeJS.ErrnoException) => {
      // The lookup hook's refusal arrives here, and must not be reported as a
      // generic network error: "blocked" is the security-relevant outcome.
      const blocked = e.message === "SSRF_BLOCKED_ADDRESS" || e.code === "EACCES";
      done({ kind: "fail", reason: blocked ? "blocked" : "network" });
    });
    req.end();
  });
}

/**
 * Fetch a page for metadata extraction, revalidating every redirect hop.
 *
 * Returns a decoded string rather than a stream or a Response, so no caller
 * has to think about charsets or size caps.
 */
export async function fetchGuardedPage(
  url: string,
  opts: { userAgent?: string; accept?: string } = {},
): Promise<GuardedPage> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const userAgent = opts.userAgent ?? "AthenaeumIntake/1.0 (+https://library.zillearn.com)";
  const accept = opts.accept ?? "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1";

  const first = admitUrl(url);
  if (!first.ok) return { ok: false, reason: first.reason, finalUrl: url };

  let current = url;
  for (let hops = 0; hops <= MAX_HOPS; hops++) {
    if (Date.now() >= deadline) return { ok: false, reason: "timeout", finalUrl: current };

    const r = await requestOnce(current, deadline, userAgent, accept);

    if (r.kind === "fail") {
      return { ok: false, reason: r.reason, finalUrl: current, status: r.status };
    }

    if (r.kind === "redirect") {
      const hop = nextHop(r.location, current, hops);
      if (hop.kind === "stop") return { ok: false, reason: hop.reason, finalUrl: current };
      current = hop.url;
      continue;
    }

    let body = decode(r.buf, charsetOf(r.contentType));
    // A page may declare a charset the header omitted or contradicts. Re-decode
    // once if the document disagrees; this matters for the CJK encodings a
    // Singapore reader will meet (shift_jis, gb18030, big5).
    const declared = body.slice(0, 2048).match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i);
    if (declared) {
      const label = declared[1].toLowerCase();
      if (label !== charsetOf(r.contentType)) body = decode(r.buf, label);
    }
    return {
      ok: true,
      body,
      contentType: r.contentType,
      finalUrl: current,
      hops,
      truncated: r.truncated,
    };
  }
  return { ok: false, reason: "too-many-hops", finalUrl: current };
}
