/**
 * Membership suspension and the inactivity lapse rule.
 *
 *   npx tsx scripts/test-member-status.ts
 *
 * Pure: no database, no network.
 *
 * This decides whether to suspend a real person's library account, so the
 * refusals matter more than the successes. A rule that fires when it should not
 * blocks somebody at the counter; a rule that never fires is merely useless.
 */
import {
  statusAllowsBorrowing,
  lastActiveAt,
  daysInactive,
  decideLapse,
  SEED_MEMBER_STATUSES,
  RETIRED_MEMBER_STATUSES,
  type StatusRule,
} from "../src/lib/member-status";

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
const NOW = d("2026-08-28T04:00:00Z");

const rules: StatusRule[] = [
  { name: "Active", suspends: false, isDefault: true, autoAfterInactiveDays: null },
  { name: "Suspended", suspends: true, isDefault: false, autoAfterInactiveDays: 365 },
  { name: "On Secondment", suspends: false, isDefault: false, autoAfterInactiveDays: null },
];

console.log("Borrowing follows suspension, and nothing else:");
{
  check("an active member may borrow", statusAllowsBorrowing("Active", rules));
  check("a seconded member may borrow", statusAllowsBorrowing("On Secondment", rules));
  check("a suspended member may not", !statusAllowsBorrowing("Suspended", rules));

  // A status with no row behind it: bulk imported, or removed from the list.
  // Treating that as permissive would mean deleting a status quietly unblocks
  // everybody who was on it.
  check("an unknown status is refused", !statusAllowsBorrowing("Alumni", rules));
  check("an unknown status that reads as active is allowed", statusAllowsBorrowing("ACTIVE", rules));
  check("case-insensitively", statusAllowsBorrowing("active", rules));
  check("an empty status is refused", !statusAllowsBorrowing("", rules));
  check("a lookalike is refused", !statusAllowsBorrowing("Inactive", rules));
}

console.log("\nLast activity counts borrowing and reserving, not browsing:");
{
  const joined = d("2020-01-01T00:00:00Z");
  check(
    "a member who never used the library ages from their join date",
    lastActiveAt({ joinedAt: joined, loans: [], reservations: [] }).getTime() === joined.getTime(),
  );
  check(
    "a borrow counts",
    lastActiveAt({
      joinedAt: joined,
      loans: [{ borrowedAt: d("2026-01-05T00:00:00Z"), returnedAt: null }],
      reservations: [],
    }).toISOString() === "2026-01-05T00:00:00.000Z",
  );
  check(
    "a return counts, and beats the borrow",
    lastActiveAt({
      joinedAt: joined,
      loans: [{ borrowedAt: d("2026-01-05T00:00:00Z"), returnedAt: d("2026-02-05T00:00:00Z") }],
      reservations: [],
    }).toISOString() === "2026-02-05T00:00:00.000Z",
  );
  check(
    "a reservation counts",
    lastActiveAt({
      joinedAt: joined,
      loans: [],
      reservations: [{ reservedAt: d("2026-03-01T00:00:00Z") }],
    }).toISOString() === "2026-03-01T00:00:00.000Z",
  );
  check(
    "the most recent of several wins",
    lastActiveAt({
      joinedAt: joined,
      loans: [
        { borrowedAt: d("2024-01-01T00:00:00Z"), returnedAt: d("2024-02-01T00:00:00Z") },
        { borrowedAt: d("2025-06-01T00:00:00Z"), returnedAt: null },
      ],
      reservations: [{ reservedAt: d("2023-01-01T00:00:00Z") }],
    }).toISOString() === "2025-06-01T00:00:00.000Z",
  );
}

console.log("\nDay counting:");
{
  check("same instant is 0 days", daysInactive(NOW, NOW) === 0);
  check("one day", daysInactive(d("2026-08-27T04:00:00Z"), NOW) === 1);
  check("365 days", daysInactive(d("2025-08-28T04:00:00Z"), NOW) === 365);
  check("part of a day rounds down", daysInactive(d("2026-08-27T05:00:00Z"), NOW) === 0);
  // A clock skew or a future-dated record must not produce a negative age that
  // reads as "extremely inactive" once compared.
  check("a future date is 0, not negative", daysInactive(d("2027-01-01T00:00:00Z"), NOW) === 0);
}

console.log("\nThe rule fires only when it should:");
{
  const member = (over: Partial<{ status: string; openLoans: number; lastActive: Date }> = {}) => ({
    status: "Active",
    openLoans: 0,
    lastActive: d("2024-01-01T00:00:00Z"),
    ...over,
  });

  const lapsed = decideLapse(member(), rules, NOW);
  check("a long-dormant member lapses", lapsed.lapse, JSON.stringify(lapsed));
  check("to the configured status", lapsed.lapse && lapsed.toStatus === "Suspended");
  check("with the day count recorded", lapsed.lapse && lapsed.daysInactive > 365);

  const recent = decideLapse(member({ lastActive: d("2026-08-01T00:00:00Z") }), rules, NOW);
  check("a recently active member does not", !recent.lapse && recent.reason === "still active");

  // Exactly on the boundary counts as reached: 365 days means 365.
  const exact = decideLapse(member({ lastActive: d("2025-08-28T04:00:00Z") }), rules, NOW);
  check("exactly at the threshold lapses", exact.lapse, JSON.stringify(exact));
  const oneShort = decideLapse(member({ lastActive: d("2025-08-29T04:00:00Z") }), rules, NOW);
  check("one day short does not", !oneShort.lapse);

  // The three refusals that matter.
  const holding = decideLapse(member({ openLoans: 1 }), rules, NOW);
  check(
    "a member still holding a book is never lapsed",
    !holding.lapse && holding.reason === "open loans",
    JSON.stringify(holding),
  );
  const already = decideLapse(member({ status: "Suspended" }), rules, NOW);
  check(
    "an already suspended member is left alone",
    !already.lapse && already.reason === "already suspended",
  );
  const noRule = decideLapse(
    member(),
    rules.map((r) => ({ ...r, autoAfterInactiveDays: null })),
    NOW,
  );
  check("no configured rule means no action", !noRule.lapse && noRule.reason === "no rule");

  // A library that sets 0 has switched it off, not set it to "immediately".
  const zero = decideLapse(
    member(),
    rules.map((r) => (r.suspends ? { ...r, autoAfterInactiveDays: 0 } : r)),
    NOW,
  );
  check("zero days means off, not instant", !zero.lapse && zero.reason === "no rule");
  const negative = decideLapse(
    member(),
    rules.map((r) => (r.suspends ? { ...r, autoAfterInactiveDays: -5 } : r)),
    NOW,
  );
  check("a negative period is ignored", !negative.lapse);

  // A member on a non-suspending custom status is still eligible.
  const seconded = decideLapse(member({ status: "On Secondment" }), rules, NOW);
  check("a seconded member can still lapse", seconded.lapse);
}

console.log("\nThe strictest configured rule wins:");
{
  const two: StatusRule[] = [
    { name: "Active", suspends: false, isDefault: true, autoAfterInactiveDays: null },
    { name: "Dormant", suspends: true, isDefault: false, autoAfterInactiveDays: 180 },
    { name: "Closed", suspends: true, isDefault: false, autoAfterInactiveDays: 730 },
  ];
  const m = { status: "Active", openLoans: 0, lastActive: d("2025-01-01T00:00:00Z") };
  const r = decideLapse(m, two, NOW);
  check(
    "the shorter period applies first",
    r.lapse && r.toStatus === "Dormant",
    JSON.stringify(r),
  );
  // Adding a stricter rule must take effect rather than being masked.
  const veryOld = decideLapse({ ...m, lastActive: d("2020-01-01T00:00:00Z") }, two, NOW);
  check("a very old member still takes the strictest", veryOld.lapse && veryOld.toStatus === "Dormant");
}

console.log("\nThe seeded statuses are coherent:");
{
  const names = SEED_MEMBER_STATUSES.map((s) => s.name);
  check("Active is seeded", names.includes("Active"));
  check("Suspended is seeded", names.includes("Suspended"));
  check("On Secondment is seeded", names.includes("On Secondment"), names.join(", "));
  check("Alumni is retired", (RETIRED_MEMBER_STATUSES as readonly string[]).includes("Alumni"));
  check("Alumni is not also seeded", !(names as readonly string[]).includes("Alumni"));
  check(
    "exactly one default",
    SEED_MEMBER_STATUSES.filter((s) => s.isDefault).length === 1,
  );
  check(
    "the default does not suspend",
    SEED_MEMBER_STATUSES.find((s) => s.isDefault)?.suspends === false,
  );
  check(
    "only a suspending status carries a lapse period",
    SEED_MEMBER_STATUSES.every((s) => s.autoAfterInactiveDays === null || s.suspends),
  );
  // Shipping a live lapse period would suspend real members on the first night.
  check(
    "no lapse rule is switched on by default",
    SEED_MEMBER_STATUSES.every((s) => s.autoAfterInactiveDays === null),
  );
}

console.log(
  failures === 0
    ? "\nCLEAN: suspension is the only thing that blocks borrowing, an unknown status is refused rather than waved through, and the lapse rule never touches a member who still holds a book."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
