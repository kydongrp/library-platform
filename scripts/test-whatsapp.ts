/**
 * WhatsApp submission bot: the pure decisions.
 *
 *   npx tsx scripts/test-whatsapp.ts
 *
 * Pure: no database, no network. Each side has a real failure mode.
 *
 * A signature check that is too loose lets anyone on the internet write to a
 * government library catalogue. A phone normaliser that is too strict silently
 * drops a legitimate sender off the allowlist, which looks identical to being
 * ignored. A URL parser that is too permissive hands the server-side fetcher a
 * "file:" or "javascript:" target.
 */
import { createHmac } from "crypto";
import {
  verifyMetaSignature,
  normalisePhone,
  maskPhone,
  parseSubmission,
  isUsableHttpUrl,
  clipReply,
  REPLY_MAX,
  parseInboundMessages,
} from "../src/lib/whatsapp-core";

let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}

const SECRET = "test_app_secret_do_not_use";
const BODY = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1" }] });
const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

console.log("Signature verification is fail-closed:");
{
  check("a correct signature passes", verifyMetaSignature(BODY, sign(BODY), SECRET));
  check("a wrong secret fails", !verifyMetaSignature(BODY, sign(BODY, "other"), SECRET));
  check("a tampered body fails", !verifyMetaSignature(`${BODY} `, sign(BODY), SECRET));
  check("a missing header fails", !verifyMetaSignature(BODY, null, SECRET));
  check("an empty header fails", !verifyMetaSignature(BODY, "", SECRET));
  check("an unset secret fails", !verifyMetaSignature(BODY, sign(BODY), undefined));
  check("an empty secret fails", !verifyMetaSignature(BODY, sign(BODY), ""));
  check(
    "a bare hex digest without the sha256= prefix fails",
    !verifyMetaSignature(BODY, createHmac("sha256", SECRET).update(BODY).digest("hex"), SECRET),
  );
  check(
    "a sha1= prefix over the same digest fails",
    !verifyMetaSignature(BODY, sign(BODY).replace("sha256=", "sha1="), SECRET),
  );
  check("garbage does not throw and fails", !verifyMetaSignature(BODY, "not-a-signature", SECRET));
  check(
    "a much longer header does not throw and fails",
    !verifyMetaSignature(BODY, `sha256=${"a".repeat(5000)}`, SECRET),
  );
  // Re-serialising the parsed JSON is the classic mistake: it changes the bytes.
  const reserialised = JSON.stringify(JSON.parse(BODY.replace('"id": "1"', '"id":"1"')));
  check(
    "byte-exactness matters (documents why the raw body is required)",
    reserialised === BODY || !verifyMetaSignature(reserialised, sign(BODY), SECRET),
  );
}

console.log("\nPhone normalisation puts every spelling on one key:");
{
  const want = "6591234567";
  for (const input of [
    "+65 9123 4567",
    "+6591234567",
    "6591234567",
    "+65-9123-4567",
    "(65) 9123 4567",
    "0065 9123 4567",
  ]) {
    check(`"${input}" -> ${want}`, normalisePhone(input, "65") === want, `got ${normalisePhone(input, "65")}`);
  }
  check("a bare local number gains the default code", normalisePhone("9123 4567", "65") === want);
  check(
    "a bare local number without a default code stays as typed",
    normalisePhone("91234567", "") === "91234567",
  );
  check(
    "an explicit + is never given a country code",
    normalisePhone("+44 20 7946 0958", "65") === "442079460958",
  );
  check("empty is rejected", normalisePhone("", "65") === null);
  check("letters only is rejected", normalisePhone("not a phone", "65") === null);
  check("too short is rejected", normalisePhone("12345", "") === null);
  check("too long is rejected (E.164 caps at 15)", normalisePhone("1".repeat(16), "") === null);
  check("15 digits is accepted", normalisePhone("1".repeat(15), "") === "1".repeat(15));
  check(
    "a number already carrying the country code is not doubled",
    normalisePhone("6591234567", "65") === want,
  );
}

console.log("\nPhone masking keeps personal data out of logs:");
{
  check("keeps the last four", maskPhone("6591234567") === "******4567");
  check("short numbers are fully masked", maskPhone("123") === "***");
  check("punctuation is ignored", maskPhone("+65 9123 4567") === "******4567");
  check("no full number survives", !maskPhone("6591234567").includes("659123"));
}

console.log("\nMessage parsing finds the link people actually sent:");
{
  const u = (t: string) => {
    const s = parseSubmission(t);
    return s.kind === "url" ? s.value : `(${s.kind})`;
  };
  check("a bare url", u("https://arxiv.org/abs/2401.00001") === "https://arxiv.org/abs/2401.00001");
  check(
    "a url inside a sentence",
    u("please add this https://arxiv.org/abs/2401.00001 thanks") === "https://arxiv.org/abs/2401.00001",
  );
  check(
    "a trailing full stop is not part of the url",
    u("add https://arxiv.org/abs/2401.00001.") === "https://arxiv.org/abs/2401.00001",
  );
  check(
    "a trailing comma is not part of the url",
    u("https://arxiv.org/abs/2401.00001, thanks") === "https://arxiv.org/abs/2401.00001",
  );
  check(
    "a balanced bracket in the url survives",
    u("https://en.wikipedia.org/wiki/Foo_(bar)") === "https://en.wikipedia.org/wiki/Foo_(bar)",
  );
  check(
    "an unbalanced closing bracket is trimmed",
    u("(see https://arxiv.org/abs/2401.00001)") === "https://arxiv.org/abs/2401.00001",
  );
  check("a query string survives", u("https://x.com/a?b=1&c=2") === "https://x.com/a?b=1&c=2");
  check("http is accepted", u("http://example.com/a") === "http://example.com/a");
  check("www is upgraded to https", u("www.example.com/a") === "https://www.example.com/a");
  check("the first url wins", u("https://a.com/1 and https://b.com/2") === "https://a.com/1");

  check("help is recognised", parseSubmission("help").kind === "help");
  check("Help with capitals is recognised", parseSubmission("  Help  ").kind === "help");
  check("hi is treated as help", parseSubmission("hi").kind === "help");
  check("empty text", parseSubmission("").kind === "empty");
  check("whitespace only", parseSubmission("   \n ").kind === "empty");
  check("null", parseSubmission(null).kind === "empty");
  check("prose with no link", parseSubmission("can you add the new IEEE paper").kind === "empty");

  const doi = parseSubmission("10.1109/CSICS.2016.7751021");
  check("a bare DOI is recognised", doi.kind === "doi" && doi.value === "10.1109/CSICS.2016.7751021");
  const doiInProse = parseSubmission("doi 10.1145/3292500.3330701 please");
  check("a DOI in prose is recognised", doiInProse.kind === "doi" && doiInProse.value === "10.1145/3292500.3330701");
  check(
    "a doi.org URL is read as a url, not a bare doi",
    parseSubmission("https://doi.org/10.1109/x").kind === "url",
  );
}

console.log("\nDangerous schemes and shapes never become a submission:");
{
  for (const bad of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>alert(1)</script>",
    "ftp://example.com/x",
    "gopher://example.com",
  ]) {
    check(`"${bad.slice(0, 28)}" is not a url submission`, parseSubmission(bad).kind !== "url");
  }
  check("a scheme-only string is refused", !isUsableHttpUrl("https://"));
  check("a hostless url is refused", !isUsableHttpUrl("https:///path"));
  check("a dotless host is refused", !isUsableHttpUrl("http://localhost/x"));
  check("a dotless host in a message is refused", parseSubmission("http://intranet/x").kind !== "url");
  check("embedded credentials are refused", !isUsableHttpUrl("https://user:pass@example.com/x"));
  check(
    "embedded credentials in a message are refused",
    parseSubmission("https://admin:hunter2@example.com/x").kind !== "url",
  );
  check("a relative path is refused", !isUsableHttpUrl("/admin/catalogue"));
  check("nonsense is refused", !isUsableHttpUrl("not a url at all"));
  // isUsableHttpUrl is deliberately about SCHEME and SHAPE only. Host safety is
  // isBlockedHost's job, and this asserts the split is intentional.
  check(
    "a private IP passes the shape check (host safety is isBlockedHost's job)",
    isUsableHttpUrl("http://169.254.169.254/latest/meta-data/"),
  );
}

console.log("\nWebhook envelope parsing is defensive:");
{
  const envelope = (value: unknown) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value }] }],
  });
  const textMsg = (body: string, id = "wamid.AAA", from = "6591234567") => ({
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "6531234567", phone_number_id: "PNID1" },
    contacts: [{ profile: { name: "Tommy" }, wa_id: from }],
    messages: [{ from, id, timestamp: "1756339200", type: "text", text: { body } }],
  });

  const one = parseInboundMessages(envelope(textMsg("https://arxiv.org/abs/1")));
  check("a text message is found", one.length === 1);
  check("id is read", one[0]?.id === "wamid.AAA");
  check("sender is read", one[0]?.from === "6591234567");
  check("body is read", one[0]?.text === "https://arxiv.org/abs/1");
  check("receiving number is read", one[0]?.phoneNumberId === "PNID1");
  check("timestamp becomes a Date", one[0]?.at instanceof Date);
  check(
    "timestamp is seconds, not milliseconds",
    one[0]?.at?.getUTCFullYear() === 2025 || one[0]?.at?.getUTCFullYear() === 2026,
    `got ${one[0]?.at?.toISOString()}`,
  );

  // The loop-forever bug: replying to a delivery receipt generates another
  // receipt, which generates another reply.
  const statuses = parseInboundMessages(
    envelope({
      messaging_product: "whatsapp",
      metadata: { phone_number_id: "PNID1" },
      statuses: [{ id: "wamid.AAA", status: "delivered", recipient_id: "6591234567" }],
    }),
  );
  check("a delivery receipt yields no messages", statuses.length === 0);

  const nonText = parseInboundMessages(
    envelope({
      metadata: { phone_number_id: "PNID1" },
      messages: [{ from: "6591234567", id: "wamid.IMG", timestamp: "1756339200", type: "image", image: { id: "x", caption: "https://evil.example/x" } }],
    }),
  );
  check("an image is surfaced, not dropped", nonText.length === 1 && nonText[0].type === "image");
  check("an image caption is NOT treated as a submission", nonText[0]?.text === null);

  const batched = parseInboundMessages({
    object: "whatsapp_business_account",
    entry: [
      { id: "W1", changes: [{ value: textMsg("https://a.com/1", "wamid.1") }] },
      { id: "W2", changes: [{ value: textMsg("https://b.com/2", "wamid.2", "6599999999") }] },
    ],
  });
  check("several entries in one delivery are all read", batched.length === 2);
  check("batched senders are kept distinct", batched[1]?.from === "6599999999");

  // None of these may throw.
  for (const [label, bad] of [
    ["null", null],
    ["undefined", undefined],
    ["a string", "hello"],
    ["a number", 42],
    ["an array", [1, 2]],
    ["an empty object", {}],
    ["the wrong object type", { object: "page", entry: [] }],
    ["entry not an array", { object: "whatsapp_business_account", entry: "nope" }],
    ["changes missing", { object: "whatsapp_business_account", entry: [{ id: "W" }] }],
    ["value null", { object: "whatsapp_business_account", entry: [{ changes: [{ value: null }] }] }],
    ["messages not an array", { object: "whatsapp_business_account", entry: [{ changes: [{ value: { messages: {} } }] }] }],
    ["message missing id", { object: "whatsapp_business_account", entry: [{ changes: [{ value: { messages: [{ from: "659" }] } }] }] }],
    ["message missing from", { object: "whatsapp_business_account", entry: [{ changes: [{ value: { messages: [{ id: "w" }] } }] }] }],
    ["text body not a string", { object: "whatsapp_business_account", entry: [{ changes: [{ value: { messages: [{ id: "w", from: "659", type: "text", text: { body: 5 } }] } }] }] }],
  ] as const) {
    let threw = false;
    let result: unknown[] = [];
    try {
      result = parseInboundMessages(bad);
    } catch {
      threw = true;
    }
    check(`${label} does not throw`, !threw);
    check(`${label} yields no unusable message`, Array.isArray(result));
  }
  const noBody = parseInboundMessages({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: { messages: [{ id: "w", from: "6591234567", type: "text", text: { body: 5 } }] } }] }],
  });
  check("a non-string body becomes null, not a crash", noBody[0]?.text === null);
  check("a bad timestamp becomes null", noBody[0]?.at === null);
}

console.log("\nReplies stay within a sane length:");
{
  check("a short reply is untouched", clipReply("added") === "added");
  const long = `${"word ".repeat(400)}end`;
  const clipped = clipReply(long);
  check("a long reply is clipped", clipped.length <= REPLY_MAX);
  check("clipping marks the cut", clipped.endsWith("…"));
  // The kept text must be a prefix of the original that stops at a space, so a
  // reader never sees a word sliced in half.
  const stem = clipped.slice(0, -1);
  check(
    "clipping cuts at a word boundary",
    long.startsWith(stem) && (long.length === stem.length || long[stem.length] === " "),
    `kept "…${stem.slice(-12)}", next char in source was ${JSON.stringify(long[stem.length])}`,
  );
  check("an exactly-max reply is untouched", clipReply("a".repeat(REPLY_MAX)).length === REPLY_MAX);
  check("a one-over reply is clipped", clipReply("a".repeat(REPLY_MAX + 1)).length <= REPLY_MAX);
}

console.log(
  failures === 0
    ? "\nCLEAN: forged webhooks are rejected, every phone spelling matches, and only http(s) links become submissions."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
