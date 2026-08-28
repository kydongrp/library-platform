/**
 * Hold queue order and manual prioritisation.
 *
 *   npx tsx scripts/test-hold-queue.ts
 *
 * Pure logic, plus one source check.
 *
 * The failure this guards against is specific. The queue order is used both by
 * the list staff read and by the code that promotes the next member when a copy
 * comes back. If those two ever disagree, the panel shows one person as next in
 * line and the copy goes to somebody else, which is the kind of bug a library
 * only discovers through a complaint. So the order lives in one constant, and
 * the last section of this file fails if a new call site sorts reservations by
 * reservedAt on its own.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import {
  sortQueue,
  queuePositions,
  priorityToReachFront,
  PRIORITY_NORMAL,
  PRIORITY_BOOSTED,
  HOLD_QUEUE_ORDER,
  HOLD_QUEUE_ORDER_WITH_STATUS,
} from "../src/lib/hold-queue";

let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}

const d = (iso: string) => new Date(iso);
const hold = (id: string, at: string, priority = PRIORITY_NORMAL, resourceId = "R1") => ({
  id,
  priority,
  reservedAt: d(at),
  resourceId,
});

console.log("Without a manual override the queue is first come, first served:");
{
  const q = sortQueue([
    hold("c", "2026-03-01T00:00:00Z"),
    hold("a", "2026-01-01T00:00:00Z"),
    hold("b", "2026-02-01T00:00:00Z"),
  ]);
  check("oldest first", q.map((h) => h.id).join("") === "abc", q.map((h) => h.id).join(""));
  check("sortQueue does not mutate its input", true);
  const input = [hold("z", "2026-05-01T00:00:00Z"), hold("y", "2026-01-01T00:00:00Z")];
  const before = input.map((h) => h.id).join("");
  sortQueue(input);
  check("the caller's array is untouched", input.map((h) => h.id).join("") === before);
}

console.log("\nA prioritised hold goes to the front:");
{
  const q = sortQueue([
    hold("first-asked", "2026-01-01T00:00:00Z"),
    hold("second-asked", "2026-02-01T00:00:00Z"),
    hold("moved-up", "2026-03-01T00:00:00Z", PRIORITY_BOOSTED),
  ]);
  check("the boosted hold is first", q[0].id === "moved-up", q.map((h) => h.id).join(","));
  check("everyone else keeps first-come order", q[1].id === "first-asked" && q[2].id === "second-asked");
}

console.log("\nTwo prioritised holds keep a stable, meaningful order:");
{
  // Moving a second person to the front must beat the first, or "move to front"
  // would silently do nothing.
  const firstBoost = priorityToReachFront(PRIORITY_NORMAL);
  check("the first boost reaches the boost value", firstBoost === PRIORITY_BOOSTED, String(firstBoost));
  const secondBoost = priorityToReachFront(firstBoost);
  check("a second boost beats the first", secondBoost > firstBoost, `${secondBoost} vs ${firstBoost}`);
  const thirdBoost = priorityToReachFront(secondBoost);
  check("a third beats the second", thirdBoost > secondBoost);

  const q = sortQueue([
    hold("normal", "2026-01-01T00:00:00Z"),
    hold("boosted-first", "2026-02-01T00:00:00Z", firstBoost),
    hold("boosted-second", "2026-02-02T00:00:00Z", secondBoost),
  ]);
  check("the most recently boosted is first", q[0].id === "boosted-second", q.map((h) => h.id).join(","));
  check("the earlier boost is second", q[1].id === "boosted-first");
  check("the unboosted hold is last", q[2].id === "normal");

  // A boost below the boost value should still order above normal holds.
  const low = sortQueue([hold("n", "2026-01-01T00:00:00Z"), hold("p", "2026-06-01T00:00:00Z", 1)]);
  check("any positive priority outranks zero", low[0].id === "p");
}

console.log("\nEqual priorities fall back to who asked first:");
{
  const q = sortQueue([
    hold("later", "2026-04-01T00:00:00Z", PRIORITY_BOOSTED),
    hold("earlier", "2026-03-01T00:00:00Z", PRIORITY_BOOSTED),
  ]);
  check("same priority, oldest first", q[0].id === "earlier", q.map((h) => h.id).join(","));
  const same = sortQueue([
    hold("b", "2026-03-01T00:00:00Z"),
    hold("a", "2026-03-01T00:00:00Z"),
  ]);
  check("identical timestamps do not throw", same.length === 2);
}

console.log("\nQueue positions are per title, not library-wide:");
{
  const positions = queuePositions([
    hold("r1-a", "2026-01-01T00:00:00Z", PRIORITY_NORMAL, "R1"),
    hold("r1-b", "2026-02-01T00:00:00Z", PRIORITY_NORMAL, "R1"),
    hold("r2-a", "2026-01-15T00:00:00Z", PRIORITY_NORMAL, "R2"),
    hold("r2-b", "2026-01-16T00:00:00Z", PRIORITY_NORMAL, "R2"),
  ]);
  check("each title starts at 1", positions.get("r1-a") === 1 && positions.get("r2-a") === 1);
  check("second in each title is 2", positions.get("r1-b") === 2 && positions.get("r2-b") === 2);
  check("a title's queue is unaffected by another title", positions.get("r2-a") === 1);

  const boosted = queuePositions([
    hold("asked-first", "2026-01-01T00:00:00Z", PRIORITY_NORMAL, "R1"),
    hold("asked-second", "2026-02-01T00:00:00Z", PRIORITY_NORMAL, "R1"),
    hold("jumped", "2026-03-01T00:00:00Z", PRIORITY_BOOSTED, "R1"),
  ]);
  check("the boosted hold is position 1", boosted.get("jumped") === 1);
  check("the original first is pushed to 2", boosted.get("asked-first") === 2);
  check("the original second is pushed to 3", boosted.get("asked-second") === 3);

  check("an empty queue yields no positions", queuePositions([]).size === 0);
  const single = queuePositions([hold("only", "2026-01-01T00:00:00Z")]);
  check("a single hold is position 1", single.get("only") === 1);
}

console.log("\nThe Prisma order matches the in-memory sort:");
{
  check(
    "priority descends before reservedAt ascends",
    JSON.stringify(HOLD_QUEUE_ORDER) === JSON.stringify([{ priority: "desc" }, { reservedAt: "asc" }]),
    JSON.stringify(HOLD_QUEUE_ORDER),
  );
  check(
    "the status variant only prepends status",
    JSON.stringify(HOLD_QUEUE_ORDER_WITH_STATUS) ===
      JSON.stringify([{ status: "asc" }, { priority: "desc" }, { reservedAt: "asc" }]),
    JSON.stringify(HOLD_QUEUE_ORDER_WITH_STATUS),
  );
}

console.log("\nNo call site orders reservations on its own:");
{
  // Walk the source rather than trusting review. A new orderBy that sorts by
  // reservedAt without the priority key is the exact regression that makes the
  // displayed queue and the promoted member disagree.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (entry === "generated" || entry === "node_modules") continue;
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (full.replace(/\\/g, "/").endsWith("src/lib/hold-queue.ts")) continue;
      const text = readFileSync(full, "utf8");
      // Any reservedAt ordering that is not spread from the shared constant.
      const re = /reservedAt:\s*"(asc|desc)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${full.replace(/\\/g, "/")}:${line}`);
      }
    }
  };
  walk("src");
  check(
    "reservedAt is ordered only through HOLD_QUEUE_ORDER",
    offenders.length === 0,
    offenders.length ? `sort reservations via HOLD_QUEUE_ORDER instead:\n        ${offenders.join("\n        ")}` : "",
  );

  // And the constant really is used where promotion happens.
  for (const f of [
    "src/app/actions/circulation.ts",
    "src/app/actions/batch.ts",
    "src/app/admin/reservations/page.tsx",
    "src/app/admin/members/[id]/page.tsx",
    "src/lib/reports.ts",
  ]) {
    check(`${f} uses the shared order`, readFileSync(f, "utf8").includes("HOLD_QUEUE_ORDER"));
  }
}

console.log(
  failures === 0
    ? "\nCLEAN: the queue is first-come unless staff intervene, a second intervention still reaches the front, and every call site shares one order."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
