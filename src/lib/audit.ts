// Append-only audit trail (IM8: accountability). Call audit() after any
// successful admin mutation. Recording must NEVER break the action it
// documents, so failures are swallowed; and the app exposes no update or
// delete path for AuditLog rows.
import { prisma } from "@/lib/db";
import { getCurrentAdmin, requestMeta } from "@/lib/admin-session";

export type AuditEntry = {
  action: string; // dot notation: "catalogue.update", "ep.approve", …
  summary: string; // human-readable one-liner
  entity?: string; // model touched, e.g. "Resource"
  entityId?: string;
  detail?: unknown; // before/after snapshot or payload extract (JSON-serialisable)
  actor?: { name: string; id?: string }; // omit to resolve the current session
};

const DETAIL_MAX = 8_000; // keep rows small; detail is an extract, not a dump

function boundDetail(detail: unknown): object | undefined {
  if (detail == null) return undefined;
  try {
    const s = JSON.stringify(detail);
    if (s.length <= DETAIL_MAX) return JSON.parse(s);
    return { truncated: true, extract: s.slice(0, DETAIL_MAX) };
  } catch {
    return { unserialisable: true };
  }
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    let actor = entry.actor;
    if (!actor) {
      const admin = await getCurrentAdmin();
      actor = admin ? { name: admin.name, id: admin.id } : { name: "unknown" };
    }
    const meta = await requestMeta();
    await prisma.auditLog.create({
      data: {
        actor: actor.name,
        actorId: actor.id ?? null,
        action: entry.action,
        entity: entry.entity ?? null,
        entityId: entry.entityId ?? null,
        summary: entry.summary.slice(0, 500),
        detail: boundDetail(entry.detail) as never,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ? meta.userAgent.slice(0, 300) : null,
      },
    });
  } catch (e) {
    // Auditing must never take down the mutation it records, but a failed
    // write must not vanish either: this tag is the hook for log-based alerts.
    console.error(
      "[audit-write-failed]",
      entry.action,
      e instanceof Error ? e.message : e,
    );
  }
}

/** Convenience for changed-field snapshots: {field: [before, after]} for diffs only. */
export function diffOf(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[k];
    const a = after[k];
    if (JSON.stringify(b) !== JSON.stringify(a)) out[k] = [b ?? null, a ?? null];
  }
  return out;
}
