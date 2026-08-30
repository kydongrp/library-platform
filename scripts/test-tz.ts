/**
 * Timezone primitive tests.
 *
 *   npx tsx scripts/test-tz.ts
 *
 * These are the tests the bug needed. Every case is stated as an instant in UTC
 * and an expected answer for Singapore, so running them under TZ=UTC (Vercel),
 * TZ=Asia/Singapore (a laptop here) or TZ=America/New_York (a colleague) must
 * give identical results. The suite re-runs itself under all three to prove it.
 */
import { spawnSync } from "node:child_process";
import {
  LIBRARY_TZ,
  zonedDayKey,
  zonedWeekday,
  startOfZonedDay,
  startOfZonedDayKey,
  zonedWallClockToInstant,
  parseZonedDateTimeLocal,
  toZonedDateTimeLocalValue,
  daysBetweenDayKeys,
  daysBetweenInstants,
} from "../src/lib/tz";

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
}
const eq = (a: unknown, b: unknown, label: string) =>
  check(a === b, label, a === b ? "" : `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

function run() {
  console.log(`\nZone under test: ${LIBRARY_TZ} · process TZ: ${process.env.TZ ?? "(unset)"}`);

  console.log("\n1. The calendar day of an instant");
  // 16:00 UTC is midnight in Singapore, so the day rolls there and not at 00:00Z.
  eq(zonedDayKey(new Date("2026-08-23T15:59:59Z")), "2026-08-23", "23:59:59 SGT is still the 23rd");
  eq(zonedDayKey(new Date("2026-08-23T16:00:00Z")), "2026-08-24", "00:00 SGT is the 24th");
  eq(zonedDayKey(new Date("2026-08-24T00:00:00Z")), "2026-08-24", "08:00 SGT is the 24th");
  eq(zonedDayKey(new Date("2026-08-24T12:00:00Z")), "2026-08-24", "noon UTC keys to the same day");
  // This is the window the whole bug lived in.
  eq(
    zonedDayKey(new Date("2026-08-23T17:30:00Z")),
    "2026-08-24",
    "01:30 SGT keys to today, not yesterday",
  );

  console.log("\n2. Weekday of the Singapore day");
  // 2026-08-23 is a Sunday, 2026-08-24 a Monday.
  eq(zonedWeekday(new Date("2026-08-23T15:00:00Z")), 0, "Sunday evening SGT is Sunday");
  eq(zonedWeekday(new Date("2026-08-23T17:00:00Z")), 1, "Monday 01:00 SGT is Monday, not Sunday");

  console.log("\n3. Start of the day");
  eq(
    startOfZonedDay(new Date("2026-08-24T05:00:00Z")).toISOString(),
    "2026-08-23T16:00:00.000Z",
    "midnight SGT on the 24th is 16:00Z on the 23rd",
  );
  eq(
    startOfZonedDayKey("2026-08-24")?.toISOString(),
    "2026-08-23T16:00:00.000Z",
    "the same, from a day key",
  );
  eq(startOfZonedDayKey("not-a-date"), null, "a malformed key is rejected");

  console.log("\n4. Wall clock to instant, which is the booking bug");
  eq(
    parseZonedDateTimeLocal("2026-08-24T14:00")?.toISOString(),
    "2026-08-24T06:00:00.000Z",
    "2pm Singapore is 06:00Z, not 14:00Z",
  );
  eq(
    parseZonedDateTimeLocal("2026-08-24T00:00")?.toISOString(),
    "2026-08-23T16:00:00.000Z",
    "midnight Singapore",
  );
  eq(parseZonedDateTimeLocal("2026-08-24T14:00:30")?.getUTCSeconds(), 30, "seconds are kept");
  eq(parseZonedDateTimeLocal("garbage"), null, "malformed input is rejected, not an Invalid Date");
  eq(parseZonedDateTimeLocal("2026-08-24"), null, "a date with no time is rejected");
  // A round trip must be lossless, or a prefilled form would drift on every save.
  const rt = "2026-12-31T23:45";
  eq(toZonedDateTimeLocalValue(parseZonedDateTimeLocal(rt)!), rt, "wall clock round-trips");
  eq(
    toZonedDateTimeLocalValue(new Date("2026-08-23T16:00:00Z")),
    "2026-08-24T00:00",
    "an instant renders as the Singapore wall clock",
  );

  console.log("\n5. Wall clock to instant, directly");
  eq(
    zonedWallClockToInstant(2026, 8, 24, 9, 30).toISOString(),
    "2026-08-24T01:30:00.000Z",
    "09:30 on the 24th in Singapore",
  );
  eq(
    zonedWallClockToInstant(2026, 1, 1).toISOString(),
    "2025-12-31T16:00:00.000Z",
    "new year's midnight in Singapore falls on the previous UTC day",
  );

  console.log("\n6. Day arithmetic");
  eq(daysBetweenDayKeys("2026-08-24", "2026-08-27"), 3, "three days forward");
  eq(daysBetweenDayKeys("2026-08-27", "2026-08-24"), -3, "and backward");
  eq(daysBetweenDayKeys("2026-08-24", "2026-08-24"), 0, "same day is zero");
  eq(daysBetweenDayKeys("2026-02-28", "2026-03-01"), 1, "non-leap February rolls to March");
  eq(daysBetweenDayKeys("2028-02-28", "2028-03-01"), 2, "leap February has the extra day");
  eq(daysBetweenDayKeys("2026-12-31", "2027-01-01"), 1, "across the year");
  // The instant form is what "Due today" depends on.
  eq(
    daysBetweenInstants(new Date("2026-08-23T17:00:00Z"), new Date("2026-08-24T09:00:00Z")),
    0,
    "01:00 and 17:00 SGT on the same day are zero days apart",
  );
  eq(
    daysBetweenInstants(new Date("2026-08-23T15:00:00Z"), new Date("2026-08-23T17:00:00Z")),
    1,
    "two hours apart across Singapore midnight is one day",
  );

  console.log("\n6. A day that would break a naive fixed-offset shortcut");
  // Singapore has had no DST since 1982, but a leap second free, non-integer
  // historical offset would still be handled: 1981 ran at UTC+7:30.
  const beforeChange = new Date("1981-06-15T16:45:00Z"); // 00:15 on the 16th at +7:30
  eq(zonedDayKey(beforeChange), "1981-06-16", "the 1981 +07:30 offset is honoured, not assumed");

  console.log("\n7. A date-only column read back into <input type=\"date\">");
  // The member edit form used member.membershipStartAt.toISOString().slice(0, 10),
  // which is the UTC calendar day, not the library's. It now goes through
  // zonedDayKey. What has to hold is that the field shows back exactly the day
  // that was picked, whatever time of day the column happens to hold, because
  // more than one writer will eventually put dates in it.
  {
    // Convention today: parseDateField in src/app/actions/members.ts stores
    // `${v}T12:00:00.000Z`, which is 20:00 Singapore on the same day.
    const storedNoonUtc = (day: string) => new Date(`${day}T12:00:00.000Z`);
    // A plausible second writer, e.g. an import that builds the library's own
    // midnight. 16:00Z the day BEFORE: the UTC date part reads a day early.
    const storedMidnightSgt = (day: string) => {
      const [y, m, d] = day.split("-").map(Number);
      return zonedWallClockToInstant(y, m, d);
    };

    const roundTripFailures: string[] = [];
    let wouldHaveBeenWrong = 0;
    // Every day of a leap year, so month ends, the year rollover and 29 Feb are
    // all covered rather than sampled.
    for (let i = 0; i < 366; i++) {
      const day = zonedDayKey(new Date(Date.UTC(2024, 0, 1) + i * 86_400_000));
      for (const store of [storedNoonUtc, storedMidnightSgt]) {
        const instant = store(day);
        if (zonedDayKey(instant) !== day) roundTripFailures.push(`${day} -> ${zonedDayKey(instant)}`);
        if (instant.toISOString().slice(0, 10) !== day) wouldHaveBeenWrong++;
      }
    }
    check(
      roundTripFailures.length === 0,
      "every day of 2024 survives the round trip under both storage conventions",
      roundTripFailures.slice(0, 3).join(", "),
    );
    // Not an incidental number: it is the whole reason the line changed.
    eq(wouldHaveBeenWrong, 366, "the old UTC-slice reading was a day out for every library-midnight value");

    // The specific instant that made this worth fixing.
    const midnightSgt = new Date("2026-08-23T16:00:00.000Z");
    eq(zonedDayKey(midnightSgt), "2026-08-24", "a value stored at library midnight reads as that day");
    eq(midnightSgt.toISOString().slice(0, 10), "2026-08-23", "and the old reading showed the day before");

    // The end of a year is where an off-by-one day is most visible: a
    // membership expiring on 1 Jan must not display as 31 Dec of last year.
    eq(zonedDayKey(storedMidnightSgt("2027-01-01")), "2027-01-01", "new year holds");
    eq(zonedDayKey(storedNoonUtc("2027-01-01")), "2027-01-01", "and under the noon-UTC convention too");
    eq(zonedDayKey(storedMidnightSgt("2024-02-29")), "2024-02-29", "29 February holds");
  }

  console.log("\n8. Every answer is independent of the runtime's own zone");
  const sample = new Date("2026-08-23T17:30:00Z");
  eq(zonedDayKey(sample), "2026-08-24", "day key does not move with process.env.TZ");
  eq(
    startOfZonedDay(sample).toISOString(),
    "2026-08-23T16:00:00.000Z",
    "start of day does not move either",
  );
}

// Prove the zone independence rather than assert it: the offset cache inside
// Intl is per-formatter and TZ is read at formatter construction, so this file
// re-executes itself in a child process under three different runtime zones.
const zones = ["UTC", "Asia/Singapore", "America/New_York"];
if (process.env.TZ_SUITE_CHILD) {
  run();
  process.exit(failures === 0 ? 0 : 1);
} else {
  let bad = 0;
  for (const tz of zones) {
    // Re-enter through tsx: the child is a TypeScript file, and TZ is read when
    // the process starts, so it cannot be changed from inside one run.
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
