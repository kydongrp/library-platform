"use client";

import { useState } from "react";
import { Card, Badge } from "@/components/ui";
import { StatefulForm, SubmitButton } from "@/components/forms";
import {
  createGroup,
  updateGroupMatrix,
  createAdminUser,
  updateAdminUser,
} from "@/app/actions/admin-settings";
import { ADMIN_AREAS, AREA_LABELS } from "@/lib/admin-areas";
import { initials } from "@/lib/format";

const inputCls =
  "rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

/* ---------- Admin users ---------- */

type UserRow = {
  id: string;
  name: string;
  email: string;
  status: string;
  groupId: string;
  groupName: string;
};

export function AdminUsersSection({
  users,
  groups,
  currentAdminId,
  readOnly,
}: {
  users: UserRow[];
  groups: { id: string; name: string }[];
  currentAdminId: string;
  readOnly: boolean;
}) {
  const [showNew, setShowNew] = useState(false);

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-display text-xl font-semibold">Staff accounts</h2>
        {!readOnly && (
          <button
            type="button"
            onClick={() => setShowNew((v) => !v)}
            className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            {showNew ? "Cancel" : "+ Add staff"}
          </button>
        )}
      </div>

      {showNew && (
        <Card className="mb-4 p-5">
          <StatefulForm action={createAdminUser} className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="new-admin-name">Name</label>
              <input id="new-admin-name" name="name" required className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="new-admin-email">Email</label>
              <input id="new-admin-email" name="email" type="email" required className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="new-admin-group">Group</label>
              <select id="new-admin-group" name="groupId" className={inputCls}>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <SubmitButton pendingLabel="Creating…">Create</SubmitButton>
          </StatefulForm>
        </Card>
      )}

      <Card className="divide-y divide-border overflow-hidden">
        {users.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              {initials(u.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {u.name}
                {u.id === currentAdminId && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
              </p>
              <p className="truncate text-xs text-muted-foreground">{u.email}</p>
            </div>
            {readOnly ? (
              <>
                <Badge tone="neutral">{u.groupName}</Badge>
                <Badge tone={u.status === "ACTIVE" ? "success" : "danger"}>{u.status.toLowerCase()}</Badge>
              </>
            ) : (
              <StatefulForm action={updateAdminUser} className="flex items-center gap-2">
                <input type="hidden" name="id" value={u.id} />
                <select name="groupId" defaultValue={u.groupId} className={`${inputCls} !py-1.5 text-xs`}>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <select name="status" defaultValue={u.status} className={`${inputCls} !py-1.5 text-xs`}>
                  <option value="ACTIVE">Active</option>
                  <option value="SUSPENDED">Suspended</option>
                </select>
                <SubmitButton variant="outline" className="!px-3 !py-1.5 text-xs" pendingLabel="…">Save</SubmitButton>
              </StatefulForm>
            )}
          </div>
        ))}
      </Card>
    </section>
  );
}

/* ---------- Groups & matrix ---------- */

export function NewGroupForm() {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
      >
        + New group
      </button>
    );
  }
  return (
    <StatefulForm action={createGroup} className="flex items-end gap-2">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="new-group-name">Name</label>
        <input id="new-group-name" name="name" required className={inputCls} />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="new-group-desc">Description</label>
        <input id="new-group-desc" name="description" className={inputCls} />
      </div>
      <SubmitButton pendingLabel="Creating…">Create</SubmitButton>
      <button type="button" onClick={() => setOpen(false)} className="px-2 py-2 text-sm text-muted-foreground">
        Cancel
      </button>
    </StatefulForm>
  );
}

type GroupData = {
  id: string;
  name: string;
  description: string | null;
  userCount: number;
  permissions: { area: string; canView: boolean; canEdit: boolean }[];
};

export function GroupMatrix({ group, readOnly }: { group: GroupData; readOnly: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const perms = new Map(group.permissions.map((p) => [p.area, p]));
  const viewCount = group.permissions.filter((p) => p.canView).length;
  const editCount = group.permissions.filter((p) => p.canEdit).length;

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-muted/40"
      >
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg font-semibold">{group.name}</p>
          {group.description && <p className="truncate text-sm text-muted-foreground">{group.description}</p>}
        </div>
        <Badge tone="neutral">{group.userCount} staff</Badge>
        <Badge tone="primary">{viewCount} view · {editCount} edit</Badge>
        <span className="text-muted-foreground">{expanded ? "▴" : "▾"}</span>
      </button>

      {expanded && (
        <div className="border-t border-border px-5 py-4">
          <StatefulForm action={updateGroupMatrix}>
            <input type="hidden" name="groupId" value={group.id} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Module</th>
                    <th className="py-2 pr-4 text-center font-medium">View</th>
                    <th className="py-2 text-center font-medium">Edit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {ADMIN_AREAS.map((area) => {
                    const p = perms.get(area);
                    return (
                      <tr key={area}>
                        <td className="py-2 pr-4">{AREA_LABELS[area]}</td>
                        <td className="py-2 pr-4 text-center">
                          <input type="checkbox" name={`view_${area}`} defaultChecked={p?.canView ?? false}
                            disabled={readOnly} aria-label={`View ${AREA_LABELS[area]}`}
                            className="h-4 w-4 accent-[var(--primary)]" />
                        </td>
                        <td className="py-2 text-center">
                          <input type="checkbox" name={`edit_${area}`} defaultChecked={p?.canEdit ?? false}
                            disabled={readOnly} aria-label={`Edit ${AREA_LABELS[area]}`}
                            className="h-4 w-4 accent-[var(--primary)]" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!readOnly && (
              <div className="mt-4">
                <SubmitButton pendingLabel="Saving…">Save matrix</SubmitButton>
              </div>
            )}
          </StatefulForm>
        </div>
      )}
    </Card>
  );
}
