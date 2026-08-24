import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { NO_VALUE, formatDate } from "@/lib/format";
import { currentStop, nextStop, runState } from "@/lib/routing-core";
import {
  AddSubscriberForm,
  SubscriberControls,
  StartRoutingButton,
  RouteOutButton,
  RouteInButton,
  SendAlertsButton,
  CancelRoutingButton,
} from "./widgets";

export const dynamic = "force-dynamic";

/** Received issues shown for routing; older ones stay in the serials list. */
const RECENT_ISSUES = 8;
/** Plus in-flight runs beyond that window, bounded so the page stays cheap. */
const IN_FLIGHT_MAX = 20;

export default async function SerialRoutingPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminView("CATALOGUE");
  const editable = canEdit(admin, "CATALOGUE");
  const { id } = await params;

  const serial = await prisma.serial.findUnique({
    where: { id },
    include: {
      resource: { select: { id: true, title: true } },
      routing: {
        include: { member: { select: { name: true, email: true, department: true } } },
        // id breaks ties so an equal-seq pair still renders in a stable order.
        orderBy: [{ seq: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!serial) notFound();

  // Two bounded queries rather than one unbounded read: the newest issues,
  // plus any issue still carrying a routing run. An unfinished circulation
  // must not fall off the page once newer issues arrive, and a serial with
  // years of history must not be loaded whole to prove it.
  const issueInclude = {
    routingStops: {
      include: { member: { select: { name: true } } },
      orderBy: [{ seq: "asc" as const }, { id: "asc" as const }],
    },
  };
  const [recent, inFlight] = await Promise.all([
    prisma.serialIssue.findMany({
      where: { serialId: serial.id, status: "RECEIVED" },
      orderBy: { seq: "desc" },
      take: RECENT_ISSUES,
      include: issueInclude,
    }),
    prisma.serialIssue.findMany({
      where: { serialId: serial.id, status: "RECEIVED", routingStops: { some: {} } },
      orderBy: { seq: "desc" },
      take: IN_FLIGHT_MAX,
      include: issueInclude,
    }),
  ]);
  const byId = new Map(recent.map((i) => [i.id, i]));
  for (const i of inFlight) byId.set(i.id, i);
  const shown = [...byId.values()].sort((a, b) => b.seq - a.seq);

  const routed = serial.routing.filter((r) => !r.alertOnly);
  const alertOnly = serial.routing.filter((r) => r.alertOnly);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Routing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <Link href={`/admin/catalogue/${serial.resource.id}`} className="hover:underline">
            {serial.resource.title}
          </Link>
        </p>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Each received issue circulates through the routing list in order: route it out to one
          person at a time, route it back in when it returns. Alert-only members are told an issue
          arrived without being handed the copy.
        </p>
        <p className="mt-2 text-sm">
          <Link href="/admin/serials" className="text-primary hover:underline">
            ← Back to Serials
          </Link>
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        {/* Received issues and their runs */}
        <div className="space-y-4">
          <h2 className="font-display text-xl font-semibold">Received issues</h2>
          {shown.length === 0 ? (
            <EmptyState
              title="Nothing received yet"
              description="Check an issue in from the Serials page, then route it from here."
            />
          ) : (
            shown.map((issue) => {
              const stops = issue.routingStops;
              const state = runState(stops);
              const out = currentStop(stops);
              const next = nextStop(stops);
              const done = stops.filter((s) => s.routedIn).length;

              return (
                <Card key={issue.id} className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{issue.label}</p>
                      <p className="text-xs text-muted-foreground">
                        Received {issue.receivedAt ? formatDate(issue.receivedAt) : NO_VALUE}
                        {stops.length > 0 && ` · ${done} of ${stops.length} stops complete`}
                        {issue.alertsSentAt && ` · alerts sent ${formatDate(issue.alertsSentAt)}`}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {stops.length === 0 ? (
                        <Badge tone="muted">not routed</Badge>
                      ) : state === "COMPLETE" ? (
                        <Badge tone="success">run complete</Badge>
                      ) : state === "OUT" ? (
                        <Badge tone="accent">out with {out?.member.name}</Badge>
                      ) : (
                        <Badge tone="neutral">in the library</Badge>
                      )}
                    </div>
                  </div>

                  {stops.length > 0 && (
                    <ol className="mt-3 divide-y divide-border border-t border-border">
                      {stops.map((s) => (
                        <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                          <span>
                            <span
                              className="mr-2 text-xs text-muted-foreground"
                              style={{ fontVariantNumeric: "tabular-nums" }}
                            >
                              {s.seq}.
                            </span>
                            {s.member.name}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {s.routedIn
                              ? `out ${formatDate(s.routedOut!)} · back ${formatDate(s.routedIn)}`
                              : s.routedOut
                                ? `out since ${formatDate(s.routedOut)}`
                                : "waiting"}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}

                  {editable && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                      {stops.length === 0 && routed.length > 0 && <StartRoutingButton issueId={issue.id} />}
                      {stops.length === 0 && routed.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          Add someone to the routing list to circulate this issue.
                        </p>
                      )}
                      {out && <RouteInButton issueId={issue.id} from={out.member.name} />}
                      {!out && next && <RouteOutButton issueId={issue.id} to={next.member.name} />}
                      {serial.routing.length > 0 && (
                        <SendAlertsButton
                          issueId={issue.id}
                          count={serial.routing.length}
                          alreadySent={!!issue.alertsSentAt}
                        />
                      )}
                      {stops.length > 0 && state !== "COMPLETE" && (
                        <CancelRoutingButton issueId={issue.id} outWith={out?.member.name ?? null} />
                      )}
                    </div>
                  )}
                </Card>
              );
            })
          )}
        </div>

        {/* The list itself */}
        <div className="space-y-4">
          <Card className="p-5">
            <h2 className="mb-1 font-display text-base font-semibold">
              Routing order ({routed.length})
            </h2>
            <p className="mb-3 text-xs text-muted-foreground">
              The order issues circulate in. A run in progress keeps the order it started with.
            </p>
            {routed.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">No one receives this title yet.</p>
            ) : (
              <ol className="divide-y divide-border">
                {routed.map((r, i) => (
                  <li key={r.id} className="py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm">
                        <span
                          className="mr-2 text-xs text-muted-foreground"
                          style={{ fontVariantNumeric: "tabular-nums" }}
                        >
                          {i + 1}.
                        </span>
                        {r.member.name}
                      </span>
                      {editable && (
                        <SubscriberControls
                          id={r.id}
                          alertOnly={false}
                          isFirst={i === 0}
                          isLast={i === routed.length - 1}
                          name={r.member.name}
                        />
                      )}
                    </div>
                    <p className="ml-5 text-xs text-muted-foreground">
                      {r.member.email}
                      {r.member.department ? ` · ${r.member.department}` : ""}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="mb-1 font-display text-base font-semibold">
              Alert only ({alertOnly.length})
            </h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Notified when an issue arrives, never handed the copy.
            </p>
            {alertOnly.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">Nobody yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {alertOnly.map((r) => (
                  <li key={r.id} className="py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm">{r.member.name}</span>
                      {editable && (
                        <SubscriberControls
                          id={r.id}
                          alertOnly
                          isFirst
                          isLast
                          name={r.member.name}
                        />
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{r.member.email}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {editable && (
            <Card className="p-5">
              <h2 className="mb-3 font-display text-base font-semibold">Add someone</h2>
              <AddSubscriberForm serialId={serial.id} />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
