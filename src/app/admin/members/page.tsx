import { requireAdminView } from "@/lib/admin-guard";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { canEdit } from "@/lib/admin-session";
import { Card, Badge, ButtonLink, EmptyState } from "@/components/ui";
import { ActionButton, StatefulForm, SubmitButton } from "@/components/forms";
import {
  setStatusLapseRule,
  makeDefaultStatus,
  deleteMemberStatus,
  deleteMemberLocation,
  deleteMemberDepartment,
} from "@/app/actions/members";
import { MEMBER_TYPE_LABELS } from "@/lib/constants";
import { initials, formatDate } from "@/lib/format";
import { StatusForm, ImportMembersForm, RegListForm } from "./widgets";

type SearchParams = Promise<{ q?: string; status?: string }>;

export default async function MembersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const admin = await requireAdminView("MEMBERS");
  const editable = canEdit(admin, "MEMBERS");

  const { q = "", status: statusFilter = "" } = await searchParams;

  const [members, statuses, statusCounts, locations, departments] = await Promise.all([
    prisma.member.findMany({
      where: {
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { email: { contains: q, mode: "insensitive" } },
                { department: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
      },
      include: { _count: { select: { loans: { where: { status: "ACTIVE" } } } } },
      orderBy: { name: "asc" },
    }),
    prisma.memberStatus.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.member.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.memberLocation.findMany({ orderBy: { name: "asc" } }),
    prisma.memberDepartment.findMany({ orderBy: { name: "asc" } }),
  ]);

  const suspendsByName = new Map(statuses.map((s) => [s.name, s.suspends]));
  const countByStatus = new Map(statusCounts.map((c) => [c.status, c._count._all]));

  const inputCls =
    "rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Members</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {members.length} member{members.length === 1 ? "" : "s"}
            {(q || statusFilter) && " matching your filters"}.
          </p>
        </div>
        <ButtonLink href="/admin/members/new">+ Add member</ButtonLink>
      </div>

      <form className="mb-6 flex flex-wrap gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search name, email, department…"
          className={`min-w-56 flex-1 ${inputCls}`}
        />
        <select name="status" defaultValue={statusFilter} className={inputCls} aria-label="Status filter">
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s.id} value={s.name}>{s.name}</option>
          ))}
        </select>
        <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
          Filter
        </button>
        {(q || statusFilter) && (
          <Link href="/admin/members" className="px-2 py-2 text-sm text-muted-foreground hover:text-foreground">
            Clear
          </Link>
        )}
      </form>

      {members.length === 0 ? (
        <EmptyState title="No members found" description="Add a member, adjust the filters, or bulk-import below." action={<ButtonLink href="/admin/members/new">+ Add member</ButtonLink>} />
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {members.map((m) => (
            <Link key={m.id} href={`/admin/members/${m.id}`} className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/50">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                {initials(m.name)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{m.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {m.email}
                  {m.department ? ` · ${m.department}` : ""}
                  {m.location ? ` · ${m.location}` : ""}
                </p>
              </div>
              <div className="hidden text-right text-xs text-muted-foreground sm:block">
                Joined {formatDate(m.joinedAt)}
              </div>
              <Badge tone="neutral">{MEMBER_TYPE_LABELS[m.memberType]}</Badge>
              {m.status !== "Active" && (
                <Badge tone={suspendsByName.get(m.status) === true ? "danger" : "accent"}>{m.status}</Badge>
              )}
              <Badge tone="primary">{m._count.loans} on loan</Badge>
            </Link>
          ))}
        </Card>
      )}

      {editable && (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {/* Status registry */}
          <Card className="p-5">
            <h2 className="mb-1 font-display text-lg font-semibold">Member statuses</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              A suspended member cannot borrow and cannot sign in to the learner portal. The
              default status is applied to new and imported members. A suspending status can
              also be applied automatically once a member has gone unused for a set number of
              days.
            </p>
            <ul className="divide-y divide-border">
              {statuses.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium">{s.name}</span>
                    {s.isDefault && <Badge tone="primary">default</Badge>}
                    {s.suspends && <Badge tone="danger">suspended</Badge>}
                    {s.autoAfterInactiveDays && (
                      <Badge tone="muted">after {s.autoAfterInactiveDays}d inactive</Badge>
                    )}
                    <span className="text-xs text-muted-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {countByStatus.get(s.name) ?? 0} member{(countByStatus.get(s.name) ?? 0) === 1 ? "" : "s"}
                    </span>
                  </div>
                  <span className="flex items-center gap-1.5">
                    {s.suspends && (
                      /* A disclosure rather than an always-visible field: the
                         rule is set once and then left alone, and a number box
                         on every row invites an accidental edit. */
                      <details className="text-xs">
                        <summary className="cursor-pointer rounded-lg px-2 py-1 hover:bg-muted">
                          {s.autoAfterInactiveDays ? "Change lapse rule" : "Set lapse rule"}
                        </summary>
                        <StatefulForm action={setStatusLapseRule} className="mt-1 flex items-center gap-1.5">
                          <input type="hidden" name="id" value={s.id} />
                          <input
                            name="days"
                            type="number"
                            min="0"
                            max="3650"
                            defaultValue={s.autoAfterInactiveDays ?? ""}
                            placeholder="days"
                            aria-label={`Days of inactivity before a member becomes ${s.name}`}
                            className="w-20 rounded-lg border border-border bg-card px-2 py-1 text-xs"
                          />
                          <SubmitButton variant="outline" className="!px-2 !py-1 text-xs" pendingLabel="…">
                            Save
                          </SubmitButton>
                          <span className="text-[11px] text-muted-foreground">0 or blank = off</span>
                        </StatefulForm>
                      </details>
                    )}
                    {!s.isDefault && (
                      <>
                        <ActionButton action={makeDefaultStatus} fields={{ id: s.id }} variant="ghost"
                          className="!px-2 !py-1 text-xs" pendingLabel="…">
                          Make default
                        </ActionButton>
                        <ActionButton action={deleteMemberStatus} fields={{ id: s.id }} variant="ghost"
                          className="!px-2 !py-1 text-xs text-red-700" pendingLabel="…"
                          confirm={`Delete status "${s.name}"?`}>
                          Delete
                        </ActionButton>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-4 border-t border-border pt-4">
              <StatusForm />
            </div>
          </Card>

          {/* Registration code lists (rows 42-43) */}
          <Card className="p-5">
            <h2 className="mb-1 font-display text-lg font-semibold">Locations &amp; departments</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              The choices the member form offers at registration. Removing an
              entry never edits members; they keep the value on their record.
            </p>
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Locations
                </h3>
                <ul className="divide-y divide-border">
                  {locations.length === 0 && (
                    <li className="py-2 text-xs text-muted-foreground">
                      None yet, so the form falls back to free text.
                    </li>
                  )}
                  {locations.map((l) => (
                    <li key={l.id} className="flex items-center justify-between gap-2 py-1.5">
                      <span className="text-sm">{l.name}</span>
                      <ActionButton action={deleteMemberLocation} fields={{ id: l.id }} variant="ghost"
                        className="!px-2 !py-1 text-xs text-red-700" pendingLabel="…"
                        confirm={`Remove "${l.name}" from the list?`}>
                        Remove
                      </ActionButton>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 border-t border-border pt-3">
                  <RegListForm kind="location" />
                </div>
              </div>
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Departments
                </h3>
                <ul className="divide-y divide-border">
                  {departments.length === 0 && (
                    <li className="py-2 text-xs text-muted-foreground">
                      None yet, so the form falls back to free text.
                    </li>
                  )}
                  {departments.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-2 py-1.5">
                      <span className="text-sm">{d.name}</span>
                      <ActionButton action={deleteMemberDepartment} fields={{ id: d.id }} variant="ghost"
                        className="!px-2 !py-1 text-xs text-red-700" pendingLabel="…"
                        confirm={`Remove "${d.name}" from the list?`}>
                        Remove
                      </ActionButton>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 border-t border-border pt-3">
                  <RegListForm kind="department" />
                </div>
              </div>
            </div>
          </Card>

          {/* Bulk import */}
          <Card className="p-5">
            <h2 className="mb-1 font-display text-lg font-semibold">Bulk import members</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              CSV with a header row: <code>name</code> and <code>email</code> are
              required; <code>type</code>, <code>status</code>, <code>phone</code>,{" "}
              <code>language</code>, <code>location</code>, <code>department</code>,{" "}
              <code>maxLoans</code> are optional (lenient header names accepted).
              Existing emails are left untouched.
            </p>
            <ImportMembersForm />
          </Card>
        </div>
      )}
    </div>
  );
}
