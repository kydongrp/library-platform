import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card } from "@/components/ui";
import { AdminUsersSection } from "@/app/admin/settings/sections";

/**
 * Admin accounts: the staff who sign in to this panel.
 *
 * A page of their own, because they are not the same population as the people
 * in Members and confusing the two has real consequences. A member is a library
 * patron who borrows and signs in to the learner portal; an admin account is
 * staff with permissions over this system. They have different identifiers,
 * different sign-in, and different consequences when one is suspended. Until
 * now the admin accounts sat as one section inside a general Settings page
 * between the permissions matrix and the search configuration, which made them
 * easy to miss and easy to mistake for a subsection of something else.
 */
export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const admin = await requireAdminView("ADMIN");
  const readOnly = !canEdit(admin, "ADMIN");

  const [users, groups, memberCount] = await Promise.all([
    prisma.adminUser.findMany({ include: { group: true }, orderBy: { name: "asc" } }),
    // Only the id and name: this feeds the group dropdown, not the matrix.
    prisma.adminGroup.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.member.count(),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Admin accounts</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Staff who sign in to this admin panel. What each account may see and change comes from
          its group, set on the{" "}
          <Link href="/admin/settings" className="text-primary hover:underline">
            access matrix
          </Link>
          .
        </p>
      </div>

      {/* The distinction is the point of this page existing, so it is stated
          rather than left to be inferred from two similar-looking lists. */}
      <Card className="mb-6 border-primary/30 bg-primary/5 p-4">
        <p className="text-sm">
          <span className="font-medium">These are not library members.</span> A member borrows
          books and signs in to the learner portal; an admin account operates this system. The two
          are separate records with separate sign-in.
        </p>
        <Link
          href="/admin/members"
          className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
        >
          Go to Members ({memberCount.toLocaleString()}) &rarr;
        </Link>
      </Card>

      <Card className="p-5">
        <AdminUsersSection
          users={users.map((u) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            status: u.status,
            groupId: u.groupId,
            groupName: u.group.name,
          }))}
          groups={groups}
          currentAdminId={admin.id}
          readOnly={readOnly}
        />
      </Card>
    </div>
  );
}
