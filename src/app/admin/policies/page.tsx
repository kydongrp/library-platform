import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card } from "@/components/ui";
import { PolicyEditor, AddOverrideForm } from "./editor";

export const dynamic = "force-dynamic";

const ORDER = ["DEFAULT", "STUDENT", "STAFF", "EXTERNAL"];

export default async function PoliciesPage() {
  const admin = await requireAdminView("POLICIES");
  const editable = canEdit(admin, "POLICIES");

  const [policies, itemTypes] = await Promise.all([
    prisma.loanPolicy.findMany({ include: { itemType: { select: { code: true, name: true } } } }),
    prisma.itemType.findMany({ orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
  ]);
  // "Any item type" rows first, then the item-type overrides beneath them.
  policies.sort(
    (a, b) =>
      ORDER.indexOf(a.memberType) - ORDER.indexOf(b.memberType) ||
      (a.itemTypeId === null ? -1 : 0) - (b.itemTypeId === null ? -1 : 0) ||
      (a.itemType?.code ?? "").localeCompare(b.itemType?.code ?? ""),
  );

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Loan Policies</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Circulation rules on the member type × item type matrix. A row with
          no item type applies to every item; add an item-type row to override
          it for that format. The DEFAULT member type covers any type without
          its own policy. Changes take effect on the next checkout or renewal.
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

      {editable && (
        <Card className="mt-6 p-5">
          <h2 className="mb-1 font-display text-lg font-semibold">Add an item-type rule</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Overrides the member type&apos;s &quot;any item type&quot; row for one format —
            the real DLS loan matrix is member type × item type.
          </p>
          <AddOverrideForm itemTypes={itemTypes} memberTypes={ORDER} />
        </Card>
      )}
    </div>
  );
}
