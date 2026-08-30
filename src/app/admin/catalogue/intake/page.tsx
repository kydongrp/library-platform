import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { Card, EmptyState } from "@/components/ui";
import { PROVIDER_GROUPS } from "@/lib/constants";
import { INTAKE_INPUT_MAX } from "@/lib/resource-intake";
import { portalLinksConfigured } from "@/lib/portal-links";
import { IntakeForm } from "./intake-form";

/**
 * Add a resource from a link.
 *
 * The fast path into the catalogue: paste a URL or a DOI, get a record and the
 * links to reach it. The full cataloguing form is still there for a title that
 * needs describing properly; this is for the common case where somebody has
 * found something and has the address.
 */
export const dynamic = "force-dynamic";

export default async function IntakePage() {
  const admin = await requireAdminView("CATALOGUE");
  const editable = canEdit(admin, "CATALOGUE");

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/admin/catalogue" className="text-sm text-muted-foreground hover:text-foreground">
        Back to catalogue
      </Link>

      <div className="mb-6 mt-3">
        <h1 className="font-display text-3xl font-semibold">Add from a link</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste a link or a DOI. The details are read from the page itself, the record is created as
          a digital link-out, and you get the URLs back. Nothing is guessed silently: where each
          field came from is shown with the result.
        </p>
      </div>

      {!editable ? (
        <EmptyState
          title="Read-only access"
          description="Your group can view the catalogue but not add to it."
        />
      ) : (
        <Card className="p-5">
          <IntakeForm
            maxLength={INTAKE_INPUT_MAX}
            providerGroups={PROVIDER_GROUPS.map((g) => ({
              label: g.label,
              providers: g.providers,
            }))}
          />
        </Card>
      )}

      <Card className="mt-6 p-5">
        <h2 className="font-display text-base font-semibold">What this does and does not do</h2>
        <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
          <li>
            A DOI resolves through Crossref, which is registry data and needs no page fetch. A link
            is fetched once, and the record is built from the publisher&rsquo;s own metadata where the
            page provides it.
          </li>
          <li>
            The same link twice does not create a second record. Tracking parameters and a trailing
            slash do not defeat that check.
          </li>
          <li>
            Everything lands as <span className="font-medium">Uncategorised</span>. Filter the
            catalogue for it to classify in a batch.
          </li>
          <li>
            The page is fetched by this server, so a link that resolves to a private address is
            refused. A page that cannot be read still produces a record, titled from its web
            address, flagged for checking.
          </li>
          {!portalLinksConfigured() && (
            <li>
              No learner-portal link is offered:{" "}
              <code className="font-mono text-xs">PORTAL_RESOURCE_URL</code> is not configured, so
              this system does not know the portal&rsquo;s URL shape.
            </li>
          )}
        </ul>
      </Card>
    </div>
  );
}
