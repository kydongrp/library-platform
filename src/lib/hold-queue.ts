/**
 * The hold queue's order, in one place.
 *
 * A reservation queue is first-come-first-served by reservedAt, with a manual
 * override so staff can move someone up (a course reserve, a supervisor's
 * request). That makes the order a two-key sort, and the danger is obvious once
 * you look: the order is used in eight places, including both the list staff
 * read and the logic that decides who is promoted when a copy comes back. If
 * those two disagree, the admin panel shows one person as next in line and the
 * system hands the copy to someone else.
 *
 * So the order is exported once, and scripts/test-hold-queue.ts fails the build
 * if a new call site orders reservations by reservedAt on its own.
 */

/**
 * Prisma orderBy for a hold queue: highest priority first, then oldest first.
 *
 * `as const` so Prisma keeps the literal types; spread it into an orderBy.
 */
export const HOLD_QUEUE_ORDER = [
  { priority: "desc" },
  { reservedAt: "asc" },
] as const;

/** The same order for a list that also groups by status (PENDING before READY). */
export const HOLD_QUEUE_ORDER_WITH_STATUS = [
  { status: "asc" },
  { priority: "desc" },
  { reservedAt: "asc" },
] as const;

/** Priority given to a hold moved to the front of the queue. */
export const PRIORITY_BOOSTED = 100;

/** Priority of an ordinary, unprioritised hold. */
export const PRIORITY_NORMAL = 0;

export type QueueEntry = {
  id: string;
  priority: number;
  reservedAt: Date;
};

/**
 * Sort a queue in memory, matching HOLD_QUEUE_ORDER exactly.
 *
 * Used for the queue-position column in reports and for tests. Kept beside the
 * Prisma order so a change to one is an obvious prompt to change the other.
 */
export function sortQueue<T extends QueueEntry>(entries: readonly T[]): T[] {
  return [...entries].sort(
    (a, b) => b.priority - a.priority || a.reservedAt.getTime() - b.reservedAt.getTime(),
  );
}

/**
 * 1-based position of each reservation in its queue, keyed by reservation id.
 *
 * Positions are per resource: a member is "3rd in line" for a title, not in the
 * library as a whole.
 */
export function queuePositions<T extends QueueEntry & { resourceId: string }>(
  entries: readonly T[],
): Map<string, number> {
  const byResource = new Map<string, T[]>();
  for (const e of entries) {
    const list = byResource.get(e.resourceId);
    if (list) list.push(e);
    else byResource.set(e.resourceId, [e]);
  }
  const out = new Map<string, number>();
  for (const list of byResource.values()) {
    sortQueue(list).forEach((e, i) => out.set(e.id, i + 1));
  }
  return out;
}

/**
 * The priority a hold needs to sit at the front of its queue.
 *
 * Not simply PRIORITY_BOOSTED: if someone has already been boosted, moving a
 * second person to the front has to beat them, or "move to front" would
 * silently do nothing. Returns the existing top priority plus one when that is
 * already at or above the boost value.
 */
export function priorityToReachFront(currentTopPriority: number): number {
  return currentTopPriority >= PRIORITY_BOOSTED ? currentTopPriority + 1 : PRIORITY_BOOSTED;
}
