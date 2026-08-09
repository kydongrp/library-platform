import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card } from "@/components/ui";
import { PolicyEditor } from "./editor";

export const dynamic = "force-dynamic";

const ORDER = ["DEFAULT", "STUDENT", "STAFF", "EXTERNAL"];

export default async function PoliciesPage() {
  const admin = await requireAdminView("POLICIES");
  const editable = canEdit(admin, "POLICIES");

  const policies = await prisma.loanPolicy.findMany();
  policies.sort((a, b) => ORDER.indexOf(a.memberType) - ORDER.indexOf(b.memberType));

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Loan Policies</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Circulation rules per member type. The DEFAULT row applies to any
          member type without its own policy. Changes take effect on the next
          checkout or renewal.
        </p>
      </div>

      {!editable && (
        <p className="mb-5 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Your group has read-only access to policies.
        </p>
      )}

      <div className="grid gap-4">
        {policies.map((p) => (
          <Card key={p.id} className="p-5">
            <PolicyEditor policy={p} readOnly={!editable} />
          </Card>
        ))}
      </div>
    </div>
  );
}
