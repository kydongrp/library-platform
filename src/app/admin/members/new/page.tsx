import { requireAdminView } from "@/lib/admin-guard";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { MemberForm } from "@/components/member-form";
import { createMember } from "@/app/actions/members";

export default async function NewMemberPage() {
  await requireAdminView("MEMBERS");

  const statuses = await prisma.memberStatus.findMany({
    orderBy: { createdAt: "asc" },
    select: { name: true, canBorrow: true, isDefault: true },
  });
  const [regLocations, regDepartments] = await Promise.all([
    prisma.memberLocation.findMany({ orderBy: { name: "asc" }, select: { name: true } }),
    prisma.memberDepartment.findMany({ orderBy: { name: "asc" }, select: { name: true } }),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/admin/members" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back to members
      </Link>
      <h1 className="mb-6 mt-2 font-display text-3xl font-semibold">Add a member</h1>
      <MemberForm action={createMember} statuses={statuses}
        locations={regLocations.map((l) => l.name)} departments={regDepartments.map((d) => d.name)} submitLabel="Create member" />
    </div>
  );
}
