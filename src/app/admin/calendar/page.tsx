import { startOfZonedDay, zonedDayKey, zonedWeekday } from "@/lib/tz";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { Card, Badge, EmptyState } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { deleteClosure } from "@/app/actions/calendar";
import { getCalendarConfig, loadCalendar } from "@/lib/calendar";
import { WEEKDAY_NAMES, isOpenDay, dateKey } from "@/lib/calendar-core";
import { formatDate } from "@/lib/format";
import { WeeklyClosureForm, ClosureForm } from "./widgets";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

export default async function CalendarPage() {
  const admin = await requireAdminView("POLICIES");
  const editable = canEdit(admin, "POLICIES");

  const [config, cal] = await Promise.all([getCalendarConfig(), loadCalendar()]);

  // A 21-day strip so staff can see the pattern they just configured.
  // Start of the library's day, so the strip begins on the day staff are
  // actually looking at rather than the UTC one.
  const today = startOfZonedDay(new Date());
  const strip = Array.from({ length: 21 }, (_, i) => {
    const d = new Date(today.getTime() + i * DAY_MS);
    const closure = config.closures.find((c) => dateKey(c.date) === dateKey(d));
    return { date: d, open: isOpenDay(d, cal), closureName: closure?.name ?? null };
  });

  const past = config.closures.filter((c) => dateKey(c.date) < dateKey(today));

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Library Calendar</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Days the library is shut. Due dates and hold pickup deadlines never
          land on a closed day (they roll to the next open day), and overdue
          fines do not accrue on one — an item due Friday and returned after a
          closed weekend is late, but not charged for days nobody could return it.
        </p>
      </div>

      {!editable && (
        <p className="mb-5 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Your group has read-only access to the library calendar.
        </p>
      )}

      {/* Next three weeks */}
      <Card className="mb-6 p-5">
        <h2 className="mb-1 font-display text-lg font-semibold">Next three weeks</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Closed days are marked; everything else is a working day for due dates and fines.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {strip.map((d) => (
            <div
              key={d.date.toISOString()}
              title={d.closureName ?? (d.open ? "Open" : "Closed")}
              className={`flex w-[4.25rem] flex-col items-center rounded-lg border px-1 py-1.5 text-center ${
                d.open
                  ? "border-border bg-card"
                  : "border-red-200 bg-red-50 text-red-800"
              }`}
            >
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {WEEKDAY_NAMES[zonedWeekday(d.date)].slice(0, 3)}
              </span>
              <span className="text-sm font-semibold" style={{ fontVariantNumeric: "tabular-nums" }}>
                {Number(zonedDayKey(d.date).slice(8))}
              </span>
              <span className="text-[10px]">{d.open ? "open" : "closed"}</span>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Weekly pattern */}
        <Card className="p-5">
          <h2 className="mb-1 font-display text-lg font-semibold">Weekly pattern</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Days the library is shut every week.{" "}
            {config.closedWeekdays.length === 0
              ? "Currently open seven days a week."
              : `Currently closed ${config.closedWeekdays.map((d) => WEEKDAY_NAMES[d]).join(", ")}.`}
          </p>
          {editable ? (
            <WeeklyClosureForm closedWeekdays={config.closedWeekdays} />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {config.closedWeekdays.length === 0 ? (
                <Badge tone="muted">None</Badge>
              ) : (
                config.closedWeekdays.map((d) => <Badge key={d} tone="danger">{WEEKDAY_NAMES[d]}</Badge>)
              )}
            </div>
          )}
        </Card>

        {/* Upcoming closures */}
        <Card className="p-5">
          <h2 className="mb-1 font-display text-lg font-semibold">Upcoming closures</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Fixed-date public holidays are seeded. Add the gazetted dates that
            move each year (Chinese New Year, Good Friday, Hari Raya, Vesak,
            Deepavali) and any stocktake or works days.
          </p>
          {config.upcoming.length === 0 ? (
            <EmptyState title="No upcoming closures" description="Add the year's public holidays so due dates avoid them." />
          ) : (
            <ul className="divide-y divide-border">
              {config.upcoming.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{c.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(c.date)} · {WEEKDAY_NAMES[zonedWeekday(c.date)]}
                    </p>
                  </div>
                  {editable && (
                    <ActionButton action={deleteClosure} fields={{ id: c.id }} variant="ghost"
                      className="!px-2 !py-1 text-xs text-red-700" pendingLabel="…"
                      confirm={`Remove ${c.name}? The library will count that day as open.`}>
                      Remove
                    </ActionButton>
                  )}
                </li>
              ))}
            </ul>
          )}
          {editable && (
            <div className="mt-4 border-t border-border pt-4">
              <ClosureForm />
            </div>
          )}
        </Card>
      </div>

      {past.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Past closures ({past.length})
          </summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {past.map((c) => (
              <Badge key={c.id} tone="muted">
                {formatDate(c.date)} · {c.name}
              </Badge>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
