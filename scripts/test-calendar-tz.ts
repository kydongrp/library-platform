/**
 * Due dates, open-day counting and fines at the awkward instants.
 *
 *   npx tsx scripts/test-calendar-tz.ts
 *
 * Every case sits in the window the bug lived in: between midnight and 8am in
 * Singapore, where the UTC calendar day is still yesterday. Each assertion
 * records what the old UTC-keyed code returned, so the change is legible rather
 * than just green, and the suite re-runs under three runtime zones because the
 * whole class of defect was behaviour that depended on the runtime's clock.
 */
import { spawnSync } from "node:child_process";
import {
  buildCalendar,
  dateKey,
  dueDateFrom,
  isOpenDay,
  nextOpenDay,
  openDaysBetween,
  ALWAYS_OPEN,
} from "../src/lib/calendar-core";
import { assessFine } from "../src/lib/fines";
import { daysUntil, dueLabel, isOverdue, formatDate, formatTime, NO_VALUE } from "../src/lib/format";
import { parseZonedDateTimeLocal } from "../src/lib/tz";
import { describeWindow, findClash, overlaps, validateWindow } from "../src/lib/booking-core";

let failures = 0;
function eq(actual: unknown, expected: unknown, label: string, wasBefore?: string) {
  const ok = actual === expected;
  if (!ok) failures++;
  const before = wasBefore ? `  (was ${wasBefore})` : "";
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${before}${
      ok ? "" : `: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`
    }`,
  );
}

// Sundays shut, plus one named holiday. 2026-08-23 is a Sunday.
const SUNDAYS = buildCalendar([0], []);
const WEEKENDS = buildCalendar([0, 6], []);
const HOLIDAY = buildCalendar([], ["2026-08-24"]);

function run() {
  console.log(`\nruntime TZ: ${process.env.TZ ?? "(unset)"}`);

  console.log("\n1. The calendar day of an instant in the small hours");
  // 2026-08-22T16:30Z is 00:30 on Sunday the 23rd in Singapore.
  eq(dateKey(new Date("2026-08-22T16:30:00Z")), "2026-08-23", "00:30 SGT Sunday keys to the 23rd", '"2026-08-22"');
  eq(
    isOpenDay(new Date("2026-08-22T16:30:00Z"), SUNDAYS),
    false,
    "and the library is shut, because it is Sunday there",
    "true, it read Saturday",
  );

  console.log("\n2. A due date can no longer land on a closed day");
  // Checking out at 01:00 SGT on Sunday with a same-day period: the raw due
  // instant is Sunday, so it must roll to Monday.
  eq(
    dueDateFrom(new Date("2026-08-22T17:00:00Z"), 0, SUNDAYS).toISOString(),
    "2026-08-23T17:00:00.000Z",
    "a Sunday due date rolls to Monday",
    "2026-08-22T17:00:00.000Z, a Sunday",
  );
  eq(
    dateKey(dueDateFrom(new Date("2026-08-22T17:00:00Z"), 0, SUNDAYS)),
    "2026-08-24",
    "which is Monday the 24th",
  );
  // A named holiday is keyed the same way.
  eq(
    dateKey(nextOpenDay(new Date("2026-08-23T17:00:00Z"), HOLIDAY)),
    "2026-08-25",
    "a closure date rolls past the 24th",
  );
  // The ordinary case must not move.
  eq(
    dueDateFrom(new Date("2026-08-24T06:00:00Z"), 14, ALWAYS_OPEN).toISOString(),
    "2026-09-07T06:00:00.000Z",
    "a 2pm weekday checkout is unchanged: 14 days on",
  );

  console.log("\n3. Chargeable open days across a shut weekend");
  // Due Friday 28 Aug 14:00 SGT; returned Tuesday 1 Sep 00:30 SGT.
  // The window is Sat 29, Sun 30, Mon 31, Tue 1: two of them open.
  const dueAt = new Date("2026-08-28T06:00:00Z");
  const returnedAt = new Date("2026-08-31T16:30:00Z");
  eq(
    openDaysBetween(dueAt, returnedAt, WEEKENDS),
    2,
    "returned 00:30 Tuesday is two open days late",
    "1, it lost the Tuesday",
  );
  eq(openDaysBetween(dueAt, dueAt, WEEKENDS), 0, "returned on the due date is not late");
  eq(
    openDaysBetween(dueAt, new Date("2026-08-28T16:30:00Z"), WEEKENDS),
    0,
    "returned 00:30 Saturday is not late either, the library was shut",
  );

  console.log("\n4. The fine that follows from it");
  const policy = { fineCentsPerDay: 50, fineGraceDays: 0, maxFineCents: null };
  eq(assessFine(dueAt, returnedAt, policy, WEEKENDS).cents, 100, "two open days at 50c is S$1.00", "50");
  eq(assessFine(dueAt, returnedAt, policy, WEEKENDS).chargeableDays, 2, "and two chargeable days", "1");
  eq(
    assessFine(dueAt, returnedAt, { ...policy, fineGraceDays: 2 }, WEEKENDS).cents,
    0,
    "a two-day grace absorbs it exactly",
  );
  eq(
    assessFine(dueAt, returnedAt, { ...policy, maxFineCents: 75 }, WEEKENDS).cents,
    75,
    "and the cap still binds",
  );

  console.log("\n5. Due today, seen at 01:00 in the morning");
  const at0100 = new Date("2026-08-23T17:00:00Z"); // 01:00 SGT on the 24th
  eq(daysUntil(new Date("2026-08-24T09:00:00Z"), at0100), 0, "an item due later today reads 0", "1");
  eq(dueLabel(new Date("2026-08-24T09:00:00Z"), null, at0100), "Due today", "and says Due today", '"Due in 1 day"');
  eq(daysUntil(new Date("2026-08-23T09:00:00Z"), at0100), -1, "an item due yesterday reads -1", "0");
  eq(isOverdue(new Date("2026-08-23T09:00:00Z"), null, at0100), true, "and counts as overdue", "false");
  eq(
    dueLabel(new Date("2026-08-23T09:00:00Z"), null, at0100),
    "Overdue by 1 day",
    "labelled overdue by a day",
    '"Due today"',
  );
  // 07:59 and 08:01 straddle the old UTC-midnight boundary; both are the same
  // Singapore day and must now agree.
  const at0759 = new Date("2026-08-23T23:59:00Z");
  const at0801 = new Date("2026-08-24T00:01:00Z");
  const target = new Date("2026-08-24T09:00:00Z");
  eq(daysUntil(target, at0759), daysUntil(target, at0801), "07:59 and 08:01 agree", "they differed by a day");
  eq(daysUntil(target, at0759), 0, "and both read 0");
  // The end of the Singapore day.
  eq(daysUntil(new Date("2026-08-25T02:00:00Z"), new Date("2026-08-24T15:59:00Z")), 1, "23:59 SGT still sees tomorrow as +1");

  console.log("\n6. Rendering");
  eq(formatDate(new Date("2026-08-23T17:00:00Z")), "24 Aug 2026", "01:00 SGT renders as the 24th", '"23 Aug 2026"');
  eq(formatTime(new Date("2026-08-24T09:00:00Z")), "17:00", "an hourly loan due 17:00 shows 17:00", '"09:00"');
  eq(formatTime(new Date("2026-08-24T09:00:07Z"), true), "17:00:07", "with seconds when asked");
  eq(formatDate(null), NO_VALUE, "a missing date renders as the no-value dash");

  console.log("\n7. Booking windows, entered as a Singapore wall clock");
  const bkStart = parseZonedDateTimeLocal("2026-08-24T14:00")!;
  const bkEnd = parseZonedDateTimeLocal("2026-08-24T16:00")!;
  eq(
    bkStart.toISOString(),
    "2026-08-24T06:00:00.000Z",
    "2pm stores as 06:00Z",
    "14:00Z, which is 10pm in Singapore",
  );
  eq(
    describeWindow({ startAt: bkStart, endAt: bkEnd }),
    "24 Aug 2026, 14:00 – 16:00",
    "and reads back as the same 2pm to 4pm",
  );
  eq(
    describeWindow({ startAt: bkStart, endAt: parseZonedDateTimeLocal("2026-08-25T10:00")! }),
    "24 Aug 2026, 14:00 – 25 Aug 2026, 10:00",
    "a window across midnight names both days",
  );
  // validateWindow defaults `now` to the real clock, and these fixtures name
  // 24 Aug 2026: without pinning the clock, the suite starts failing the
  // moment the real world passes the window (which it did, one day after the
  // fixtures were written). 10:00 SGT on the fixture morning keeps the window
  // in the future forever.
  const fixtureNow = new Date("2026-08-24T02:00:00.000Z");
  eq(validateWindow({ startAt: bkStart, endAt: bkEnd }, fixtureNow), null, "a normal window validates");
  eq(validateWindow({ startAt: bkEnd, endAt: bkStart }, fixtureNow), "END_BEFORE_START", "reversed is refused");
  // The half-open comparison is what lets one booking end as the next begins.
  const nextSlot = { startAt: bkEnd, endAt: parseZonedDateTimeLocal("2026-08-24T18:00")! };
  eq(
    overlaps({ startAt: bkStart, endAt: bkEnd }, nextSlot),
    false,
    "back-to-back windows still do not clash",
  );
  eq(findClash({ startAt: bkStart, endAt: bkEnd }, [nextSlot]), null, "and findClash agrees");
  eq(
    overlaps({ startAt: bkStart, endAt: parseZonedDateTimeLocal("2026-08-24T17:00")! }, nextSlot),
    true,
    "a genuine overlap still clashes",
  );

  console.log("\n8. Noon-UTC stored values are untouched by the change");
  // Closure dates and other date-only values are stored at noon UTC, which is
  // 20:00 Singapore the same day. Keying them in the zone must be a no-op.
  eq(dateKey(new Date("2026-08-24T12:00:00Z")), "2026-08-24", "a noon-UTC date keys to its own day");
  eq(isOpenDay(new Date("2026-08-24T12:00:00Z"), HOLIDAY), false, "and its closure is still found");
  eq(formatDate(new Date("2026-08-24T12:00:00Z")), "24 Aug 2026", "and renders as its own day");
}

const zones = ["UTC", "Asia/Singapore", "America/New_York"];
if (process.env.TZ_SUITE_CHILD) {
  run();
  console.log(failures === 0 ? "  (all passed)" : `  (${failures} failed)`);
  process.exit(failures === 0 ? 0 : 1);
} else {
  let bad = 0;
  for (const tz of zones) {
    const res = spawnSync(process.execPath, ["--import", "tsx", process.argv[1]], {
      env: { ...process.env, TZ: tz, TZ_SUITE_CHILD: "1" },
      stdio: "inherit",
      shell: false,
    });
    if (res.status !== 0) bad++;
  }
  console.log(
    bad === 0
      ? `\nALL PASSED under every runtime zone tried (${zones.join(", ")}).`
      : `\nFAILED under ${bad} of ${zones.length} runtime zones.`,
  );
  process.exit(bad === 0 ? 0 : 1);
}
