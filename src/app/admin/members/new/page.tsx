import { requireAdminView } from "@/lib/admin-guard";
import Link from "next/link";
import { MemberForm } from "@/components/member-form";
import { createMember } from "@/app/actions/members";

export default async function NewMemberPage() {
  await requireAdminView("MEMBERS");

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/admin/members" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back to members
      </Link>
      <h1 className="mb-6 mt-2 font-display text-3xl font-semibold">Add a member</h1>
      <MemberForm action={createMember} submitLabel="Create member" />
    </div>
  );
}
