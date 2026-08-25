/**
 * Outbound mail: the policy that decides whether to send, the transport that
 * sends, and the queue that drives both.
 *
 *   npx tsx --env-file=.env.development.local scripts/test-mail.ts
 *
 * No real provider is contacted. The transport is pointed at a stub HTTP
 * server started here, which can be told to answer 200, 500, 400 or to hang,
 * so every branch is exercised against a real socket rather than a mock object.
 *
 * The queue cases need a database and run only against neondb_test. Anywhere
 * else they are skipped by name rather than silently: the failure being guarded
 * is a test seeding rows into the production outbox, where the ten-minute drain
 * would then mail them to real members.
 */
import { createServer, type Server } from "node:http";
import { prisma } from "../src/lib/db";
import {
  dispositionFor,
  looksLikeAnAddress,
  nextAttemptAfter,
  sendingEnabled,
  MAX_ATTEMPTS,
} from "../src/lib/mail/policy";
import { resolveTransport } from "../src/lib/mail/transport";
import { drainMailQueue, retryFailedMail } from "../src/lib/mail/queue";

const SUITE = "SUITE_MAIL";
let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}

/**
 * Whether the queue cases may run.
 *
 * They write rows to the outbox, so they run against the test database and
 * nowhere else. Anywhere else, including CI's closed-port placeholder and a
 * developer whose .env points at production, the pure cases still run and the
 * rest are skipped by name. Skipping loudly beats a suite that quietly seeds
 * the production outbox, where the ten-minute drain would mail real members.
 */
function databaseName(): string {
  const url = process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL || "";
  return /\/([^/?]+)(\?|$)/.exec(url)?.[1] ?? "";
}

const DB_NAME = databaseName();
const USE_DB = DB_NAME === "neondb_test";

// ── stub provider ─────────────────────────────────────────────────────────

type StubMode = "ok" | "server-error" | "bad-request" | "hang";
let mode: StubMode = "ok";
let received: { auth: string | undefined; body: unknown }[] = [];

function startStub(): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        received.push({
          auth: req.headers.authorization,
          body: (() => {
            try {
              return JSON.parse(raw);
            } catch {
              return raw;
            }
          })(),
        });
        if (mode === "hang") return; // never answers; the transport must time out
        if (mode === "server-error") {
          res.writeHead(503).end("upstream unavailable");
          return;
        }
        if (mode === "bad-request") {
          res.writeHead(422, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "invalid from address" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "stub-message-1" }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

// ── helpers ───────────────────────────────────────────────────────────────

function configure(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function seed(
  overrides: Partial<{
    toEmail: string;
    status: string;
    attempts: number;
    createdAt: Date;
    lastAttemptAt: Date;
    nextAttemptAt: Date;
  }> = {},
): Promise<string> {
  const row = await prisma.mailQueue.create({
    data: {
      toEmail: overrides.toEmail ?? "member@example.edu",
      toName: "Test Member",
      subject: "Your loan is due soon",
      body: "The item you borrowed is due in two days.",
      template: SUITE,
      status: overrides.status ?? "QUEUED",
      attempts: overrides.attempts ?? 0,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      ...(overrides.lastAttemptAt ? { lastAttemptAt: overrides.lastAttemptAt } : {}),
      ...(overrides.nextAttemptAt ? { nextAttemptAt: overrides.nextAttemptAt } : {}),
    },
  });
  return row.id;
}

async function statusOf(id: string) {
  return prisma.mailQueue.findUniqueOrThrow({ where: { id } });
}

async function clean(): Promise<number> {
  const { count } = await prisma.mailQueue.deleteMany({ where: { template: SUITE } });
  return count;
}

/**
 * Close the stub and release the database pool before returning.
 *
 * process.exit() while the stub still holds a socket trips a libuv assertion
 * on Windows, so the suite sets an exit code and lets the process end once its
 * handles are closed. closeAllConnections is what makes that prompt: a keep
 * alive socket from the last fetch would otherwise hold close() open.
 */
async function shutdown(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect().catch(() => {});
}

// ── the suite ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(
    USE_DB
      ? `Database: ${DB_NAME}. Running every case.
`
      : `No test database (found ${JSON.stringify(DB_NAME)}), so the queue cases are skipped.
` +
        `Run with --env-file=.env.development.local for the full suite.
`,
  );
  if (USE_DB) await clean();
  const { server, base } = await startStub();
  const now = new Date("2026-08-25T02:00:00.000Z");

  const live = {
    MAIL_ENABLED: "1",
    MAIL_API_KEY: "stub-key",
    MAIL_FROM: "library@example.edu",
    MAIL_API_BASE: base,
    MAIL_ALLOWLIST: undefined,
    VERCEL_ENV: undefined,
    MAIL_MAX_AGE_HOURS: "72",
  };

  console.log("Policy refuses to send unless every condition is met:");
  {
    configure({ ...live, MAIL_ENABLED: undefined });
    check("silent when MAIL_ENABLED is unset", !sendingEnabled().enabled);

    configure({ ...live, VERCEL_ENV: "preview" });
    const preview = sendingEnabled();
    check("a preview deployment never sends", !preview.enabled);
    check(
      "and says so, even with MAIL_ENABLED on",
      /[Pp]review/.test(preview.reason ?? ""),
      preview.reason,
    );

    configure(live);
    check("sends once enabled and not a preview", sendingEnabled().enabled);
  }

  console.log("The allowlist confines a configured provider to known addresses:");
  {
    configure({ ...live, MAIL_ALLOWLIST: "me@team.example, @staff.example" });
    check("an exact address passes", dispositionFor("me@team.example").send);
    check("a listed domain passes", dispositionFor("anyone@staff.example").send);
    check("a real member does not", !dispositionFor("member@example.edu").send);
    check("matching ignores case", dispositionFor("ME@Team.Example").send);
    configure(live);
    check("no allowlist means no restriction", dispositionFor("member@example.edu").send);
  }

  console.log("Addresses that would hard bounce are refused before a provider sees them:");
  {
    for (const bad of ["", "nope", "no@domain", "two@@at.com", "spaces in@x.com"]) {
      check(`rejects ${JSON.stringify(bad)}`, !looksLikeAnAddress(bad));
    }
    check("accepts a normal address", looksLikeAnAddress("a.b-c@sub.example.edu"));
  }

  console.log("Backoff lengthens, and never returns an earlier time than the attempt before:");
  {
    const times = [1, 2, 3, 4, 5].map((n) => nextAttemptAfter(n, now).getTime());
    check("first retry is 5 minutes out", times[0] === now.getTime() + 5 * 60_000);
    check("strictly increasing then flat", times.every((t, i) => i === 0 || t >= times[i - 1]));
    check("never earlier than now", times.every((t) => t > now.getTime()));
  }

  console.log("The transport speaks to a real socket:");
  {
    configure(live);
    received = [];
    mode = "ok";
    const transport = resolveTransport();
    check("resolves to the configured host, not dry run", transport.name !== "dry-run");

    const outcome = await transport.send({
      to: "member@example.edu",
      toName: "Test Member",
      subject: "Subject line",
      body: "Body text",
    });
    check("reports success", outcome.ok, JSON.stringify(outcome));
    check(
      "returns the provider's id",
      outcome.ok && outcome.providerId === "stub-message-1",
      JSON.stringify(outcome),
    );
    const sent = received[0];
    check("authenticates with the key", sent?.auth === "Bearer stub-key", String(sent?.auth));
    const body = sent?.body as { from?: string; to?: string[]; subject?: string; text?: string };
    check("sends from the configured address", body?.from === "library@example.edu");
    check("addresses the recipient with their name", body?.to?.[0] === "Test Member <member@example.edu>");
    check("carries the subject and body", body?.subject === "Subject line" && body?.text === "Body text");
  }

  console.log("The transport tells retryable failures from permanent ones:");
  {
    mode = "server-error";
    const five = await resolveTransport().send({ to: "a@b.com", toName: "A", subject: "s", body: "b" });
    check("a 503 is retryable", !five.ok && five.retryable, JSON.stringify(five));

    mode = "bad-request";
    const four = await resolveTransport().send({ to: "a@b.com", toName: "A", subject: "s", body: "b" });
    check("a 422 is not", !four.ok && !four.retryable, JSON.stringify(four));
    check("and the reason is kept", !four.ok && /422/.test(four.error), JSON.stringify(four));

    mode = "ok";
  }

  console.log("A message with no provider configured goes nowhere, quietly:");
  {
    configure({ ...live, MAIL_API_KEY: undefined });
    check("falls back to dry run", resolveTransport().name === "dry-run");
    configure({ ...live, MAIL_FROM: undefined });
    check("a key without a from address is not enough", resolveTransport().name === "dry-run");
    configure(live);
  }

  if (!USE_DB) {
    // Every case above is pure: policy decisions and one HTTP round trip to a
    // stub on loopback. Everything below writes to the outbox, so it stops
    // here rather than seeding rows into whatever database this happens to be
    // pointed at. Named individually so a skipped run cannot be mistaken for a
    // complete one.
    for (const skipped of [
      "queue drains to SENT",
      "retryable failure backs off",
      "backoff is respected",
      "permanent failure stops at once",
      "retries are finite",
      "policy refusals are recorded",
      "sending switched off changes nothing",
      "housekeeping expires and reaps",
      "retry requeues failures but not expiries",
      "concurrent runs cannot double send",
      "a hanging provider times out",
    ]) {
      console.log(`  skip  ${skipped} (needs neondb_test)`);
    }
    await shutdown(server);
    console.log(
      failures === 0
        ? "\nCLEAN so far: policy and transport pass. Queue cases were skipped."
        : `\nFAILED: ${failures} assertion(s).`,
    );
    process.exitCode = failures === 0 ? 0 : 1;
    return;
  }

  console.log("Draining the queue moves rows to the state their outcome earned:");
  {
    configure(live);
    mode = "ok";
    const id = await seed();
    const summary = await drainMailQueue(now);
    const row = await statusOf(id);
    check("counts the send", summary.sent >= 1, JSON.stringify(summary));
    check("marks the row SENT", row.status === "SENT", row.status);
    check("stamps sentAt", row.sentAt !== null);
    check("records the provider id", row.providerId === "stub-message-1", String(row.providerId));
    check("records which transport carried it", (row.transport ?? "").startsWith("http:"), String(row.transport));
    check("counts one attempt", row.attempts === 1, String(row.attempts));
  }

  console.log("A retryable failure goes back in the queue with a backoff:");
  {
    mode = "server-error";
    const id = await seed();
    await drainMailQueue(now);
    const row = await statusOf(id);
    check("returns to QUEUED", row.status === "QUEUED", row.status);
    check("counts the attempt", row.attempts === 1, String(row.attempts));
    check("keeps the provider's reason", /503/.test(row.lastError ?? ""), String(row.lastError));
    check(
      "waits five minutes before the next try",
      row.nextAttemptAt?.getTime() === now.getTime() + 5 * 60_000,
      String(row.nextAttemptAt),
    );
  }

  console.log("A row still in backoff is left alone:");
  {
    mode = "ok";
    const id = await seed({ nextAttemptAt: new Date(now.getTime() + 60 * 60_000) });
    await drainMailQueue(now);
    const row = await statusOf(id);
    check("not picked up early", row.status === "QUEUED" && row.attempts === 0, `${row.status}/${row.attempts}`);
  }

  console.log("A permanent failure stops immediately rather than burning its retries:");
  {
    mode = "bad-request";
    const id = await seed();
    await drainMailQueue(now);
    const row = await statusOf(id);
    check("marked FAILED on the first attempt", row.status === "FAILED", row.status);
    check("after one attempt, not five", row.attempts === 1, String(row.attempts));
    check("says it will not be retried", /not retryable/.test(row.lastError ?? ""), String(row.lastError));
  }

  console.log("Retries are finite:");
  {
    mode = "server-error";
    const id = await seed({ attempts: MAX_ATTEMPTS - 1 });
    await drainMailQueue(now);
    const row = await statusOf(id);
    check(`gives up at ${MAX_ATTEMPTS} attempts`, row.status === "FAILED", row.status);
    check("clears the next attempt time", row.nextAttemptAt === null, String(row.nextAttemptAt));
    mode = "ok";
  }

  console.log("Policy refusals are recorded, not sent:");
  {
    configure({ ...live, MAIL_ALLOWLIST: "@team.example" });
    const id = await seed({ toEmail: "member@example.edu" });
    const before = received.length;
    await drainMailQueue(now);
    const row = await statusOf(id);
    check("marked SUPPRESSED", row.status === "SUPPRESSED", row.status);
    check("says why", /MAIL_ALLOWLIST/.test(row.lastError ?? ""), String(row.lastError));
    check("and the provider was never contacted", received.length === before, String(received.length - before));

    const bad = await seed({ toEmail: "not-an-address" });
    await drainMailQueue(now);
    check("an unusable address is suppressed too", (await statusOf(bad)).status === "SUPPRESSED");
    configure(live);
  }

  console.log("Sending switched off leaves the queue untouched:");
  {
    configure({ ...live, MAIL_ENABLED: undefined });
    const id = await seed();
    const summary = await drainMailQueue(now);
    check("the run reports why it did nothing", Boolean(summary.skipped), JSON.stringify(summary));
    check("the row is still QUEUED", (await statusOf(id)).status === "QUEUED");
    check("with no attempt spent", (await statusOf(id)).attempts === 0);
    configure(live);
  }

  console.log("Housekeeping runs even when sending is off:");
  {
    const stale = await seed({ createdAt: new Date(now.getTime() - 96 * 3_600_000) });
    const stuck = await seed({
      status: "SENDING",
      attempts: 1,
      lastAttemptAt: new Date(now.getTime() - 60 * 60_000),
    });
    configure({ ...live, MAIL_ENABLED: undefined });
    const summary = await drainMailQueue(now);
    check("stale rows expire rather than flooding later", (await statusOf(stale)).status === "EXPIRED");
    check("the run counts them", summary.expired >= 1, JSON.stringify(summary));
    check("a row abandoned mid-send is reclaimed", (await statusOf(stuck)).status === "QUEUED");
    check("the run counts that too", summary.reaped >= 1, JSON.stringify(summary));
    configure(live);
  }

  console.log("Retry puts failures back, and leaves expiry alone:");
  {
    mode = "bad-request";
    const failed = await seed();
    await drainMailQueue(now);
    const expired = await seed({ createdAt: new Date(now.getTime() - 96 * 3_600_000) });
    await drainMailQueue(now);

    const requeued = await retryFailedMail();
    check("requeues at least the failed row", requeued >= 1, String(requeued));
    const back = await statusOf(failed);
    check("failed row is QUEUED again", back.status === "QUEUED", back.status);
    check("with its attempt count reset", back.attempts === 0, String(back.attempts));
    check("expired rows are not revived", (await statusOf(expired)).status === "EXPIRED");
    mode = "ok";
  }

  console.log("Two runs at once cannot send the same message twice:");
  {
    mode = "ok";
    await clean();
    const ids = await Promise.all([seed(), seed(), seed()]);
    received = [];
    const [a, b] = await Promise.all([drainMailQueue(now), drainMailQueue(now)]);
    const sent = a.sent + b.sent;
    check("three messages, three sends", sent === 3, `${sent} sends across two runs`);
    check("the provider saw each message once", received.length === 3, String(received.length));
    const rows = await Promise.all(ids.map(statusOf));
    check("every row is SENT", rows.every((r) => r.status === "SENT"));
    check("and none was attempted twice", rows.every((r) => r.attempts === 1), rows.map((r) => r.attempts).join(","));
  }

  console.log("A provider that never answers does not hold the queue open:");
  {
    mode = "hang";
    const id = await seed();
    const started = Date.now();
    await drainMailQueue(now);
    const elapsed = Date.now() - started;
    const row = await statusOf(id);
    check("times out and requeues", row.status === "QUEUED", row.status);
    check("reports the timeout", /[Tt]imed out/.test(row.lastError ?? ""), String(row.lastError));
    check("within about 15 seconds", elapsed < 25_000, `${elapsed}ms`);
    mode = "ok";
  }

  const removed = await clean();
  await shutdown(server);
  console.log(`\nCleaned up ${removed} suite row${removed === 1 ? "" : "s"}.`);
  console.log(
    failures === 0
      ? "\nCLEAN: mail sends when it should, refuses when it should, and retries in between."
      : `\nFAILED: ${failures} assertion(s).`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(async (error) => {
  console.error(error);
  if (USE_DB) await clean().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exitCode = 1;
});
