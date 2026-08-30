/**
 * Link-state classification.
 *
 *   npx tsx scripts/test-link-state.ts
 *
 * Pure: no network, no database. The point of this module is that the scan
 * stopped claiming more than it saw, so what has to hold is that a subscription
 * wall is never reported as a retrieval, and a dead link is never reported as
 * anything else.
 */
import { linkState, LINK_STATE_LABEL } from "../src/lib/link-state";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
  if (!ok) failures++;
}

console.log("Never scanned is its own answer, not a pass:");
check("null is null", linkState(null) === null);
check("undefined is null", linkState(undefined) === null);

console.log("\nDead links:");
for (const [code, why] of [[404, "not found"], [410, "gone"], [500, "server error"], [503, "unavailable"]] as const) {
  check(`${code} (${why})`, linkState({ ok: false, statusCode: code }) === "BROKEN");
}
check("no response at all", linkState({ ok: false, statusCode: null }) === "BROKEN");

console.log("\nAnswered without serving the page:");
for (const code of [202, 401, 403, 429]) {
  check(`${code}`, linkState({ ok: true, statusCode: code }) === "UNVERIFIED", String(linkState({ ok: true, statusCode: code })));
}

console.log("\nActually retrieved:");
for (const code of [200, 201, 203, 204, 206, 302, 304]) {
  check(`${code}`, linkState({ ok: true, statusCode: code }) === "OK", String(linkState({ ok: true, statusCode: code })));
}

console.log("\nThe measured catalogue, 31 August 2026:");
{
  // The live distribution the day this was written. If the classifier ever
  // rounds these differently, the dashboard starts lying again.
  const live: [number, boolean, number][] = [
    [202, true, 25], // IEEE gate, empty body
    [200, true, 15],
    [403, true, 2], // ACM bot challenge
    [404, false, 1], // the reported record
  ];
  const tally: Record<string, number> = { OK: 0, BROKEN: 0, UNVERIFIED: 0 };
  for (const [statusCode, ok, n] of live) tally[linkState({ ok, statusCode })!] += n;
  tally.BROKEN += 1; // the no-response test record
  check("15 retrieved", tally.OK === 15, String(tally.OK));
  check("27 answered but unverified", tally.UNVERIFIED === 27, String(tally.UNVERIFIED));
  check("2 broken", tally.BROKEN === 2, String(tally.BROKEN));
  check(
    "the old rule would have called 42 of 44 healthy",
    tally.OK + tally.UNVERIFIED === 42,
    String(tally.OK + tally.UNVERIFIED),
  );
}

console.log("\nEvery state has wording:");
for (const s of ["OK", "BROKEN", "UNVERIFIED"] as const) {
  check(`${s} is labelled`, typeof LINK_STATE_LABEL[s] === "string" && LINK_STATE_LABEL[s].length > 0);
}

console.log(
  failures === 0
    ? "\nCLEAN: a subscription wall is never counted as a retrieval, a dead link is never counted as anything else, and an unscanned link is neither."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
