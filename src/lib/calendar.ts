// Prisma-backed service-calendar loader. Pure math is re-exported from
// calendar-core.ts (client-safe); server code can import either.

import { prisma } from "@/lib/db";
import { buildCalendar, dateKey, type CalendarIndex } from "@/lib/calendar-core";

export * from "@/lib/calendar-core";

export const CALENDAR_ID = "singleton";

/** The closure index used by due-date and fine calculations. */
export async function loadCalendar(): Promise<CalendarIndex> {
  const [config, closures] = await Promise.all([
    prisma.serviceCalendar.findUnique({ where: { id: CALENDAR_ID } }),
    prisma.libraryClosure.findMany({ select: { date: true } }),
  ]);
  return buildCalendar(
    config?.closedWeekdays ?? [],
    closures.map((c) => dateKey(c.date)),
  );
}

export type CalendarConfig = {
  closedWeekdays: number[];
  closures: { id: string; date: Date; name: string; createdBy: string | null }[];
  upcoming: { id: string; date: Date; name: string }[];
};

/** Everything the calendar admin page renders. */
export async function getCalendarConfig(now = new Date()): Promise<CalendarConfig> {
  const [config, closures] = await Promise.all([
    prisma.serviceCalendar.findUnique({ where: { id: CALENDAR_ID } }),
    prisma.libraryClosure.findMany({ orderBy: { date: "asc" } }),
  ]);
  const todayKey = dateKey(now);
  return {
    closedWeekdays: config?.closedWeekdays ?? [],
    closures,
    // Every future closure, not a capped window — anything hidden here would
    // still affect due dates but have no way to be removed.
    upcoming: closures
      .filter((c) => dateKey(c.date) >= todayKey)
      .map((c) => ({ id: c.id, date: c.date, name: c.name })),
  };
}
