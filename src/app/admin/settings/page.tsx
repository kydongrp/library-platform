import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { GroupMatrix, NewGroupForm, AdminUsersSection } from "./sections";
import { SearchConfigSection } from "./search-config";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const admin = await requireAdminView("ADMIN");
  const editable = canEdit(admin, "ADMIN");

  const [groups, users, stopWords, variants] = await Promise.all([
    prisma.adminGroup.findMany({
      include: { permissions: true, _count: { select: { users: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.adminUser.findMany({ include: { group: true }, orderBy: { name: "asc" } }),
    prisma.stopWord.findMany({ orderBy: { word: "asc" } }),
    prisma.variantSpelling.findMany({ orderBy: [{ word: "asc" }, { variant: "asc" }] }),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Admin Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Staff accounts, admin groups, and the user access matrix. Each group
          defines view/edit rights per module; staff inherit their group&apos;s
          rights.
        </p>
      </div>

      <AdminUsersSection
        users={users.map((u) => ({
          id: u.id, name: u.name, email: u.email, status: u.status,
          groupId: u.groupId, groupName: u.group.name,
        }))}
        groups={groups.map((g) => ({ id: g.id, name: g.name }))}
        currentAdminId={admin.id}
        readOnly={!editable}
      />

      <div className="mt-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-xl font-semibold">Admin groups & access matrix</h2>
          {editable && <NewGroupForm />}
        </div>
        <div className="space-y-4">
          {groups.map((g) => (
            <GroupMatrix
              key={g.id}
              group={{
                id: g.id,
                name: g.name,
                description: g.description,
                userCount: g._count.users,
                permissions: g.permissions.map((p) => ({
                  area: p.area, canView: p.canView, canEdit: p.canEdit,
                })),
              }}
              readOnly={!editable}
            />
          ))}
        </div>
      </div>

      <div className="mt-8">
        <SearchConfigSection
          stopWords={stopWords.map((w) => ({ id: w.id, word: w.word }))}
          variants={variants.map((v) => ({ id: v.id, word: v.word, variant: v.variant }))}
          readOnly={!editable}
        />
      </div>
    </div>
  );
}
