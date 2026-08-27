/**
 * SSRF guards: which hosts and addresses a server-side fetcher may reach.
 *
 *   npx tsx scripts/test-ssrf.ts
 *
 * Pure: no network. This is a security boundary, so the interesting cases are
 * the ones that LOOK public and are not.
 *
 * Measured against the previous version rather than assumed. Most numeric
 * literals were ALREADY blocked, because WHATWG URL normalises them before the
 * host is ever inspected: new URL("http://2130706433/").hostname is
 * "127.0.0.1". Those cases below are therefore regression tests, not new
 * coverage, and the initial claim that they were all exploitable was wrong.
 *
 * What genuinely was reachable, confirmed by running the old function:
 *   - IPv4-mapped IPv6, http://[::ffff:127.0.0.1]/
 *   - internal name suffixes, http://db.internal/
 *
 * And the hole no rule in this file can close: a public hostname whose A
 * record points at 169.254.169.254 or a 10.x address passes every check here,
 * because a hostname check cannot see DNS. That is why the real defence is the
 * lookup hook in src/lib/page-fetch.ts (proved live in
 * scripts/test-page-fetch-live.ts) and why redirects are chased by hand.
 */
import {
  isBlockedAddress,
  isBlockedHostname,
  isBlockedHost,
  normaliseIpv4Literal,
} from "../src/lib/net";
import { admitUrl, nextHop } from "../src/lib/page-fetch";

let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}

console.log("Private and special addresses are blocked:");
{
  for (const ip of [
    "127.0.0.1", "127.1.2.3", "10.0.0.1", "10.255.255.255",
    "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "169.254.0.1",
    "100.64.0.1", "100.127.255.255",
    "0.0.0.0", "0.1.2.3",
    "192.0.0.1", "192.0.2.1",
    "224.0.0.1", "239.255.255.255", "255.255.255.255",
  ]) {
    check(`${ip} blocked`, isBlockedAddress(ip));
  }
  for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
    check(`${ip} blocked`, isBlockedAddress(ip));
  }
  check("::ffff:127.0.0.1 blocked (v4-mapped, dotted)", isBlockedAddress("::ffff:127.0.0.1"));
  check("::127.0.0.1 blocked (v4-compatible)", isBlockedAddress("::127.0.0.1"));
  check("::ffff:7f00:1 blocked (v4-mapped, hex)", isBlockedAddress("::ffff:7f00:1"));
  check("::ffff:a9fe:a9fe blocked (metadata in hex)", isBlockedAddress("::ffff:a9fe:a9fe"));
  check("[::1] blocked despite brackets", isBlockedAddress("[::1]"));
  check("fe80::1%eth0 blocked despite zone id", isBlockedAddress("fe80::1%eth0"));
}

console.log("\nGenuinely public addresses are allowed:");
{
  for (const ip of [
    "1.1.1.1", "8.8.8.8", "93.184.216.34", "172.15.0.1", "172.32.0.1",
    "192.167.1.1", "192.169.1.1", "100.63.255.255", "100.128.0.1", "223.255.255.255",
    "2606:4700:4700::1111", "2001:4860:4860::8888",
  ]) {
    check(`${ip} allowed`, !isBlockedAddress(ip));
  }
}

console.log("\nMalformed input fails closed:");
{
  for (const bad of ["", "   ", "not-an-ip", "999.999.999.999", "1.2.3", "1.2.3.4.5", "12345"]) {
    check(`${JSON.stringify(bad)} refused`, isBlockedAddress(bad));
  }
}

console.log("\ninet_aton literals normalise (belt and braces behind URL parsing):");
{
  check("decimal 2130706433 -> 127.0.0.1", normaliseIpv4Literal("2130706433") === "127.0.0.1");
  check("hex 0x7f000001 -> 127.0.0.1", normaliseIpv4Literal("0x7f000001") === "127.0.0.1");
  check("short 127.1 -> 127.0.0.1", normaliseIpv4Literal("127.1") === "127.0.0.1");
  check("short 127.0.1 -> 127.0.0.1", normaliseIpv4Literal("127.0.1") === "127.0.0.1");
  check("octal 0177.0.0.1 -> 127.0.0.1", normaliseIpv4Literal("0177.0.0.1") === "127.0.0.1");
  check(
    "decimal 2852039166 -> 169.254.169.254",
    normaliseIpv4Literal("2852039166") === "169.254.169.254",
  );
  check("plain quad is unchanged", normaliseIpv4Literal("8.8.8.8") === "8.8.8.8");
  check("a real hostname is not a literal", normaliseIpv4Literal("example.com") === null);
  check("too many parts", normaliseIpv4Literal("1.2.3.4.5") === null);
  check("an octet over 255", normaliseIpv4Literal("999.1.1.1") === null);
  check("empty part", normaliseIpv4Literal("1..2.3") === null);
}

console.log("\ninet_aton hostnames stay blocked (regression: URL normalises these):");
{
  for (const host of [
    "2130706433", "0x7f000001", "127.1", "0177.0.0.1",
    "2852039166", "169.254.169.254", "0",
  ]) {
    check(`${host} blocked`, isBlockedHostname(host));
  }
  check("http://2130706433/ blocked end to end", isBlockedHost("http://2130706433/"));
  check("http://0x7f000001/ blocked end to end", isBlockedHost("http://0x7f000001/"));
  check(
    "the metadata endpoint in decimal is blocked end to end",
    isBlockedHost("http://2852039166/latest/meta-data/"),
  );
}

console.log("\nLocal and internal names are blocked (genuinely new coverage):");
{
  for (const host of [
    "localhost", "app.localhost", "metadata.google.internal",
    "db.internal", "printer.local", "box.localdomain", "thing.home.arpa", "x.onion",
  ]) {
    check(`${host} blocked`, isBlockedHostname(host));
  }
  check("a trailing dot does not evade (localhost.)", isBlockedHostname("localhost."));
  check("case does not evade (LOCALHOST)", isBlockedHostname("LOCALHOST"));
  check("[::1] as a url host is blocked", isBlockedHost("http://[::1]:8080/x"));
  check(
    "[::ffff:127.0.0.1] as a url host is blocked",
    isBlockedHost("http://[::ffff:127.0.0.1]/"),
  );
}

console.log("\nPublic hostnames are allowed:");
{
  for (const host of [
    "example.com", "arxiv.org", "www.ieee.org", "sub.domain.co.uk", "localhost.example.com",
  ]) {
    check(`${host} allowed`, !isBlockedHostname(host));
  }
  check("a normal https url is allowed", !isBlockedHost("https://arxiv.org/abs/1706.03762"));
  check("an unparseable url fails closed", isBlockedHost("not a url"));
  check("an empty url fails closed", isBlockedHost(""));
}

console.log("\nURL admission covers scheme, host and port:");
{
  check("a normal https page is admitted", admitUrl("https://arxiv.org/abs/1").ok);
  check("port 80 is admitted", admitUrl("http://example.com:80/x").ok);
  check("port 443 is admitted", admitUrl("https://example.com:443/x").ok);
  const p = admitUrl("http://example.com:22/");
  check("port 22 is refused as port", !p.ok && p.reason === "port");
  const p2 = admitUrl("http://example.com:6379/");
  check("port 6379 is refused as port", !p2.ok && p2.reason === "port");
  const sch = admitUrl("file:///etc/passwd");
  check("file: is refused as scheme", !sch.ok && sch.reason === "scheme");
  const blk = admitUrl("http://169.254.169.254/");
  check("the metadata literal is refused as blocked", !blk.ok && blk.reason === "blocked");
}

console.log("\nEvery redirect hop is revalidated:");
{
  const base = "https://example.com/a";
  const follow = nextHop("https://arxiv.org/abs/1", base, 0);
  check("an absolute public redirect is followed", follow.kind === "follow");
  const rel = nextHop("/b/c", base, 0);
  check(
    "a relative redirect resolves against the current url",
    rel.kind === "follow" && rel.url === "https://example.com/b/c",
    rel.kind === "follow" ? rel.url : rel.reason,
  );
  const proto = nextHop("//arxiv.org/x", base, 0);
  check(
    "a protocol-relative redirect inherits https",
    proto.kind === "follow" && proto.url === "https://arxiv.org/x",
  );

  // The whole reason redirects are chased by hand: hop 1 public, hop 2 internal.
  const meta = nextHop("http://169.254.169.254/latest/meta-data/", base, 0);
  check(
    "a redirect INTO the metadata endpoint is stopped",
    meta.kind === "stop" && meta.reason === "blocked",
    meta.kind === "stop" ? meta.reason : meta.url,
  );
  const internal = nextHop("http://db.internal/dump", base, 0);
  check(
    "a redirect into an internal name is stopped",
    internal.kind === "stop" && internal.reason === "blocked",
  );
  const scheme = nextHop("file:///etc/passwd", base, 0);
  check("a redirect to file: is stopped", scheme.kind === "stop" && scheme.reason === "scheme");
  const port = nextHop("http://example.com:22/", base, 0);
  check("a redirect to a blocked port is stopped", port.kind === "stop" && port.reason === "port");
  const jsUrl = nextHop("javascript:alert(1)", base, 0);
  check("a redirect to javascript: is stopped", jsUrl.kind === "stop");

  const none = nextHop(null, base, 0);
  check("a 3xx with no Location stops", none.kind === "stop" && none.reason === "no-location");
  const empty = nextHop("", base, 0);
  check("an empty Location stops", empty.kind === "stop" && empty.reason === "no-location");
  const tooMany = nextHop("https://arxiv.org/x", base, 3, 3);
  check("the hop budget is enforced", tooMany.kind === "stop" && tooMany.reason === "too-many-hops");
  const lastAllowed = nextHop("https://arxiv.org/x", base, 2, 3);
  check("the final permitted hop is allowed", lastAllowed.kind === "follow");
}

console.log(
  failures === 0
    ? "\nCLEAN: private space is unreachable in every encoding tested, redirects are revalidated per hop, and malformed input fails closed."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
