/**
 * LIVE test for the guarded fetcher. Needs network; not part of CI.
 *
 *   npx tsx scripts/test-page-fetch-live.ts
 *
 * The point is the DNS hook. These hostnames are public, ordinary names that
 * pass every string-based rule in src/lib/net.ts, and resolve into private
 * space. If they are not blocked, the SSRF defence does not work.
 */
import { fetchGuardedPage, admitUrl } from "../src/lib/page-fetch";
import { isBlockedHost } from "../src/lib/net";
import { isUsableHttpUrl } from "../src/lib/submission-core";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) { console.log(`  ok    ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}

void (async () => {
  console.log("Hostnames that resolve into private space (the real attack):");
  for (const host of ["localtest.me", "127.0.0.1.nip.io", "169.254.169.254.nip.io"]) {
    const url = `http://${host}/`;
    // Establish that the cheap string checks do NOT catch these.
    const shapeOk = isUsableHttpUrl(url);
    const stringOk = !isBlockedHost(url);
    const admitted = admitUrl(url).ok;
    const res = await fetchGuardedPage(url);
    check(
      `${host}: passes string checks but the fetch is blocked`,
      shapeOk && stringOk && admitted && !res.ok && res.reason === "blocked",
      `shape=${shapeOk} stringAllows=${stringOk} admitted=${admitted} result=${res.ok ? "FETCHED" : res.reason}`,
    );
  }

  console.log("\nA genuinely public page still fetches:");
  {
    const res = await fetchGuardedPage("https://example.com/");
    check("example.com fetched", res.ok, res.ok ? "" : `reason=${res.reason}`);
    if (res.ok) {
      check("body looks like html", /<html|<!doctype/i.test(res.body), res.body.slice(0, 80));
      check("content type recorded", res.contentType.includes("text/html"));
      check("no redirect hops needed", res.hops === 0);
      check("not truncated", !res.truncated);
    }
  }

  console.log("\nRefusals that need no network:");
  {
    const bad = await fetchGuardedPage("file:///etc/passwd");
    check("file: refused as scheme", !bad.ok && bad.reason === "scheme");
    const port = await fetchGuardedPage("http://example.com:22/");
    check("port 22 refused", !port.ok && port.reason === "port");
    const lit = await fetchGuardedPage("http://169.254.169.254/latest/meta-data/");
    check("the metadata IP literal refused", !lit.ok && lit.reason === "blocked");
    // Refused as "scheme": a dotless host fails isUsableHttpUrl before the
    // host or port rules are ever consulted.
    const local = await fetchGuardedPage("http://localhost:3000/");
    check(
      "localhost refused",
      !local.ok,
      local.ok ? "FETCHED LOCALHOST" : `reason=${local.reason}`,
    );
    check("localhost is refused on shape, not reached", !local.ok && local.reason === "scheme");
  }

  console.log("\nA non-html target is not decoded:");
  {
    const res = await fetchGuardedPage("https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf");
    check(
      "a pdf is rejected on content-type",
      !res.ok && (res.reason === "content-type" || res.reason === "status" || res.reason === "network"),
      res.ok ? "PDF WAS DECODED" : `reason=${res.reason}`,
    );
  }

  console.log(
    failures === 0
      ? "\nCLEAN: public names pointing at private addresses are refused at DNS, and real pages still fetch."
      : `\nFAILED: ${failures} assertion(s).`,
  );
  process.exit(failures === 0 ? 0 : 1);
})();
