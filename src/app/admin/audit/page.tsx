import { requireAdminView } from "@/lib/admin-guard";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

// Action families for the filter — matched as prefixes ("ep" → ep.*).
const ACTION_FAMILIES: { key: string; label: string }[] = [
  { key: "auth", label: "Sign-in / sign-out" },
  { key: "catalogue", label: "Catalogue" },
  { key: "ep", label: "Editor's Picks" },
  { key: "eresources", label: "E-Resources" },
  { key: "portal", label: "Portal API" },
  { key: "serials", label: "Serials" },
  { key: "acq", label: "Acquisitions" },
  { key: "calendar", label: "Library Calendar" },
  { key: "items", label: "Items" },
  { key: "marc", label: "Cataloguing (MARC)" },
  { key: "import", label: "Imports" },
  { key: "circulation", label: "Circulation" },
  { key: "members", label: "Members" },
  { key: "requests", label: "Resource requests" },
  { key: "policies", label: "Loan policies" },
  { key: "templates", label: "Email templates" },
  { key: "settings", label: "Admin settings" },
  { key: "batch", label: "Batch processes" },
];

// Entity → admin page, for click-through where a detail page exists.
function entityHref(entity: string | null, entityId: string | null): string | null {
  if (!entity || !entityId) return null;
  if (entity === "Resource") return `/admin/catalogue/${entityId}`;
  if (entity === "Member") return `/admin/members/${entityId}`;
  return null;
}

function actionTone(action: string): "primary" | "danger" | "accent" | "neutral" {
  if (action.startsWith("auth.")) return "accent";
  if (action.includes("delete") || action.includes("removeExternal") || action.includes("reject"))
    return "danger";
  return "primary";
}

type SearchParams = Promise<{ family?: string; actor?: string; q?: string }>;

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminView("ADMIN");

  const { family = "", actor = "", q = "" } = await searchParams;

  const where = {
    ...(family ? { action: { startsWith: family + "." } } : {}),
    ...(actor ? { actor } : {}),
    ...(q ? { summary: { contains: q, mode: "insensitive" as const } } : {}),
  };

  const [entries, total, actors] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { at: "desc" }, take: PAGE_SIZE }),
    prisma.auditLog.count({ where }),
    prisma.auditLog.groupBy({ by: ["actor"], orderBy: { actor: "asc" } }),
  ]);

  const selectCls =
    "rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none";
  const exportQs = new URLSearchParams({
    ...(family ? { family } : {}),
    ...(actor ? { actor } : {}),
    ...(q ? { q } : {}),
  }).toString();

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Audit Trail</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Append-only record of every admin action — who did what, and when.
            Entries are written by the system and can never be edited or deleted
            from the application.
          </p>
        </div>
        <a
          href={`/admin/audit/export${exportQs ? `?${exportQs}` : ""}`}
          className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          ⇩ Export CSV
        </a>
      </div>

      {/* Filters */}
      <form className="mb-4 flex flex-wrap items-center gap-2">
        <select name="family" defaultValue={family} className={selectCls} aria-label="Action type">
          <option value="">All actions</option>
          {ACTION_FAMILIES.map((f) => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </select>
        <select name="actor" defaultValue={actor} className={selectCls} aria-label="Actor">
          <option value="">All actors</option>
          {actors.map((a) => (
            <option key={a.actor} value={a.actor}>{a.actor}</option>
          ))}
        </select>
        <input
          name="q"
          defaultValue={q}
          placeholder="Search summaries…"
          className={`${selectCls} min-w-56 flex-1`}
        />
        <button
          type="submit"
          className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
        >
          Filter
        </button>
        {(family || actor || q) && (
          <a href="/admin/audit" className="text-sm text-muted-foreground hover:text-foreground">
            Clear
          </a>
        )}
      </form>

      <p className="mb-3 text-xs text-muted-foreground">
        {total} entr{total === 1 ? "y" : "ies"}
        {total > PAGE_SIZE ? ` · showing the ${PAGE_SIZE} most recent (narrow the filters or export CSV for the rest)` : ""}
      </p>

      {entries.length === 0 ? (
        <EmptyState
          title="No audit entries"
          description="Admin actions will appear here as they happen."
        />
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {entries.map((e) => {
            const href = entityHref(e.entity, e.entityId);
            return (
              <div key={e.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="w-36 shrink-0 pt-0.5 text-xs text-muted-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {formatDate(e.at)}
                  <br />
                  {e.at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-snug">
                    {href ? (
                      <a href={href} className="hover:underline">{e.summary}</a>
                    ) : (
                      e.summary
                    )}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone="neutral">{e.actor}</Badge>
                    <Badge tone={actionTone(e.action)}>{e.action}</Badge>
                    {e.detail != null && (
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer select-none hover:text-foreground">detail</summary>
                        <pre className="mt-1 max-w-full overflow-x-auto rounded-lg bg-muted p-2 text-[11px] leading-relaxed">
                          {JSON.stringify(e.detail, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
