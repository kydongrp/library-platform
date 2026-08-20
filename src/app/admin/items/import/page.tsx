import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card } from "@/components/ui";
import { ImportItemsForm } from "./widgets";

export const dynamic = "force-dynamic";

export default async function ItemsImportPage() {
  const admin = await requireAdminView("CATALOGUE");
  const editable = canEdit(admin, "CATALOGUE");

  const [collections, locations, itemTypes] = await Promise.all([
    prisma.itemCollection.findMany({ orderBy: { code: "asc" }, select: { code: true, name: true } }),
    prisma.itemLocation.findMany({ orderBy: { code: "asc" }, select: { code: true, name: true } }),
    prisma.itemType.findMany({ orderBy: { code: "asc" }, select: { code: true, name: true } }),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Import items</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Bulk-add barcoded copies to existing catalogue records from XML (the Vibrant exchange
          format), CSV or JSON. Each row needs a barcode plus an ISBN, title or record id to say
          which bib it belongs to. Rows with unknown codes or no matching record are reported and
          skipped, never guessed.
        </p>
        <p className="mt-2 text-sm">
          <Link href="/admin/items" className="text-primary hover:underline">← Back to Items</Link>
        </p>
      </div>

      {editable ? (
        <Card className="mb-6 p-5">
          <ImportItemsForm />
        </Card>
      ) : (
        <Card className="mb-6 p-5 text-sm text-muted-foreground">
          You have view-only access to the Items module.
        </Card>
      )}

      <Card className="p-5">
        <h2 className="mb-2 font-display text-base font-semibold">Accepted fields</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Field</th>
                <th className="py-2 pr-4 font-medium">Required</th>
                <th className="py-2 pr-4 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr><td className="py-2 pr-4 font-mono text-xs">barcode</td><td className="py-2 pr-4">Yes</td><td className="py-2 pr-4">Unique per copy. Duplicates are skipped and reported.</td></tr>
              <tr><td className="py-2 pr-4 font-mono text-xs">isbn / title / recordid</td><td className="py-2 pr-4">One of them</td><td className="py-2 pr-4">Matches the bib: record id first, then ISBN (punctuation ignored), then exact title.</td></tr>
              <tr><td className="py-2 pr-4 font-mono text-xs">collection</td><td className="py-2 pr-4">No</td><td className="py-2 pr-4">Code from the managed list: {collections.map((c) => c.code).join(", ") || "none defined yet"}.</td></tr>
              <tr><td className="py-2 pr-4 font-mono text-xs">location</td><td className="py-2 pr-4">No</td><td className="py-2 pr-4">Code from: {locations.map((c) => c.code).join(", ") || "none defined yet"}.</td></tr>
              <tr><td className="py-2 pr-4 font-mono text-xs">itemtype</td><td className="py-2 pr-4">No</td><td className="py-2 pr-4">Code from: {itemTypes.map((c) => c.code).join(", ") || "none defined yet"}.</td></tr>
              <tr><td className="py-2 pr-4 font-mono text-xs">status</td><td className="py-2 pr-4">No</td><td className="py-2 pr-4">AVAILABLE (default), MAINTENANCE or LOST. Circulation states are refused.</td></tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          XML example: {"<items><item><barcode>LIB-000123</barcode><isbn>978-0-13-468599-1</isbn><collection>GEN</collection></item></items>"}
        </p>
      </Card>
    </div>
  );
}
