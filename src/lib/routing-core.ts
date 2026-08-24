/**
 * Serial issue routing (SDD rows 69-71). Pure so it's tsx-testable; the
 * serials actions do the reads and writes.
 *
 * A routing run is a snapshot of the serial's routing list taken when staff
 * start routing a received issue. Each stop is routed OUT to a member and
 * later routed back IN; at most one stop is ever out at a time. Row 72
 * (treating each hop as an automatic loan) is deliberately not modelled:
 * the deployed Vibrant system has it switched off.
 */

export type Stop = {
  seq: number;
  routedOut: Date | null;
  routedIn: Date | null;
};

export type RunState = "NOT_STARTED" | "OUT" | "BETWEEN" | "COMPLETE";

const bySeq = <T extends Stop>(stops: T[]): T[] => [...stops].sort((a, b) => a.seq - b.seq);

/** The stop currently out with a member, if any. */
export function currentStop<T extends Stop>(stops: T[]): T | null {
  return stops.find((s) => s.routedOut && !s.routedIn) ?? null;
}

/** The next stop to route out to, if any. */
export function nextStop<T extends Stop>(stops: T[]): T | null {
  return bySeq(stops).find((s) => !s.routedOut) ?? null;
}

export function runState(stops: Stop[]): RunState {
  if (stops.length === 0) return "NOT_STARTED";
  if (currentStop(stops)) return "OUT";
  if (nextStop(stops)) return stops.some((s) => s.routedIn) ? "BETWEEN" : "NOT_STARTED";
  return "COMPLETE";
}

/**
 * Guard for routing out: only when nothing is currently out, and only to the
 * next unvisited stop. An issue is one physical object.
 */
export function canRouteOut(stops: Stop[]): { ok: true; to: Stop } | { ok: false; why: string } {
  const out = currentStop(stops);
  if (out) return { ok: false, why: `The issue is still out (stop ${out.seq}). Route it in first.` };
  const next = nextStop(stops);
  if (!next) return { ok: false, why: "Every stop on this run is complete." };
  return { ok: true, to: next };
}

export function canRouteIn(stops: Stop[]): { ok: true; from: Stop } | { ok: false; why: string } {
  const out = currentStop(stops);
  if (!out) return { ok: false, why: "The issue is not out with anyone." };
  return { ok: true, from: out };
}

/**
 * The snapshot for a new run: physical-routing subscribers only (alert-only
 * rows are notified, never handed the issue), renumbered densely from 1 so
 * gaps left by list edits don't leak into the run.
 */
export function planRun<T extends { seq: number; alertOnly: boolean }>(
  subscribers: T[],
): (T & { runSeq: number })[] {
  return [...subscribers]
    .filter((s) => !s.alertOnly)
    .sort((a, b) => a.seq - b.seq)
    .map((s, i) => ({ ...s, runSeq: i + 1 }));
}
