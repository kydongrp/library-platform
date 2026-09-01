import { requireAdminView } from "@/lib/admin-guard";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { listCategories } from "@/lib/categories";
import { Card, Badge, BookCover } from "@/components/ui";
import { SubmitButton } from "@/components/forms";
import { AddCopiesForm, EditResourceSection, MarcRecordSection } from "./sections";
import {
  setCopyStatus,
  deleteCopy,
  deleteResource,
} from "@/app/actions/catalogue";
import { COPY_STATUS_LABELS } from "@/lib/constants";
import { isDigital } from "@/lib/availability";
import { NO_VALUE, formatDate } from "@/lib/format";
import { linkState, LINK_STATE_NOTE } from "@/lib/link-state";

const STATUS_TONE: Record<string, "success" | "primary" | "accent" | "danger" | "muted"> = {
  AVAILABLE: "success",
  ON_LOAN: "primary",
  RESERVED: "accent",
  LOST: "danger",
  MAINTENANCE: "muted",
};

export default async function ResourceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requireAdminView("CATALOGUE");

  const { id } = await params;
  const { error } = await searchParams;

  // The nightly access scan already knows whether this link resolves. It was
  // recording 404s that this page then offered as a working link, so the
  // verdict is read here and shown beside the link rather than living only on
  // the access-health screen that nobody opens on their way to a record.
  const [resource, linkCheck] = await Promise.all([
    prisma.resource.findUnique({
      where: { id },
      include: {
        copies: { orderBy: { barcode: "asc" }, include: { loans: { where: { status: "ACTIVE" }, include: { member: true } } } },
        marcFields: { orderBy: { seq: "asc" } },
        _count: { select: { loans: true, reservations: { where: { status: { in: ["PENDING", "READY"] } } } } },
      },
    }),
    prisma.linkCheck.findUnique({ where: { resourceId: id } }),
  ]);

  const access = linkState(linkCheck);

  if (!resource) notFound();

  const tagDefs = await prisma.marcTagDef.findMany({ orderBy: { sortOrder: "asc" } });
  const categories = await listCategories();
  const digital = isDigital(resource);

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/admin/catalogue" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back to catalogue
      </Link>

      <div className="mb-6 mt-3 flex flex-wrap items-start gap-5">
        <BookCover title={resource.title} author={resource.author} color={resource.coverColor} type={resource.type} imageId={resource.coverImageId} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-3xl font-semibold">{resource.title}</h1>
          {resource.subtitle && <p className="text-lg text-muted-foreground">{resource.subtitle}</p>}
          <p className="mt-1 text-muted-foreground">{resource.author}</p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Badge tone={resource.materialDesignation === "SERIAL" ? "primary" : "neutral"}>
              {resource.materialDesignation === "SERIAL" ? "Serial" : "Monograph"}
            </Badge>
            <Badge tone="neutral">{resource.category}</Badge>
            {resource.provider ? (
              <Badge tone="accent">{resource.provider}</Badge>
            ) : digital ? (
              <Badge tone="primary">Digital · instant access</Badge>
            ) : (
              <Badge tone="muted">{resource.copies.length} copies</Badge>
            )}
            <Badge tone="muted">{resource._count.loans} lifetime loans</Badge>
            {resource._count.reservations > 0 && <Badge tone="accent">{resource._count.reservations} active holds</Badge>}
            {resource.digitalUrl && (
              // Still a link in every state. A cataloguer fixing a dead URL
              // needs to see what it does now, and the scan may be days old.
              // What changes is that a dead one stops looking healthy.
              <a href={resource.digitalUrl} target="_blank" rel="noopener noreferrer"
                className={`text-sm font-medium hover:underline ${
                  access === "BROKEN" ? "text-red-700" : "text-primary"
                }`}>
                {access === "BROKEN" ? "Open access link (broken) ↗" : "Open access link ↗"}
              </a>
            )}
            {access === "BROKEN" && linkCheck && (
              <Badge tone="danger">
                {linkCheck.error ?? "Did not resolve"} · checked {formatDate(linkCheck.checkedAt)}
              </Badge>
            )}
            {access === "UNVERIFIED" && linkCheck && (
              // Not an alarm. The provider answered and declined to serve the
              // page to a crawler, which is what a subscription wall looks
              // like from outside; it says the scan is not evidence either way.
              <span title={LINK_STATE_NOTE.UNVERIFIED}>
                <Badge tone="muted">
                  Not verified{linkCheck.statusCode ? ` (HTTP ${linkCheck.statusCode})` : ""} ·
                  checked {formatDate(linkCheck.checkedAt)}
                </Badge>
              </span>
            )}
          </div>
          {resource.description && <p className="mt-4 max-w-2xl text-sm text-foreground/80">{resource.description}</p>}
          <p className="mt-3 text-xs text-muted-foreground">
            Added {formatDate(resource.createdAt)}
            {resource.publishedYear ? ` · Published ${resource.publishedYear}` : ""}
            {resource.publisher ? ` · ${resource.publisher}` : ""}
            {resource.isbn ? ` · ISBN ${resource.isbn}` : ""}
          </p>
        </div>
      </div>

      {error === "active-loans" && (
        <p className="mb-5 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          This title can&apos;t be deleted while copies are out on loan. Check them in first.
        </p>
      )}

      {/* Copies management (physical only) */}
      {!digital && (
        <Card className="mb-6 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold">Copies</h2>
            <AddCopiesForm resourceId={resource.id} />
          </div>
          {resource.copies.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No copies yet. Add one above.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Barcode</th>
                    <th className="py-2 pr-4 font-medium">Location</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Borrower</th>
                    <th className="py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {resource.copies.map((copy) => {
                    const loan = copy.loans[0];
                    const onLoan = copy.status === "ON_LOAN";
                    return (
                      <tr key={copy.id}>
                        <td className="py-2.5 pr-4 font-mono text-xs">{copy.barcode}</td>
                        <td className="py-2.5 pr-4">{copy.location}</td>
                        <td className="py-2.5 pr-4">
                          <Badge tone={STATUS_TONE[copy.status]}>{COPY_STATUS_LABELS[copy.status]}</Badge>
                        </td>
                        <td className="py-2.5 pr-4 text-muted-foreground">
                          {loan ? `${loan.member.name}` : NO_VALUE}
                        </td>
                        <td className="py-2.5">
                          {onLoan ? (
                            <span className="text-xs text-muted-foreground">Return at the desk</span>
                          ) : (
                            <div className="flex items-center gap-2">
                              <form action={setCopyStatus} className="flex items-center gap-1">
                                <input type="hidden" name="copyId" value={copy.id} />
                                <input type="hidden" name="resourceId" value={resource.id} />
                                <select name="status" defaultValue={copy.status}
                                  className="rounded-md border border-border bg-card px-2 py-1 text-xs">
                                  {["AVAILABLE", "RESERVED", "MAINTENANCE", "LOST"].map((s) => (
                                    <option key={s} value={s}>{COPY_STATUS_LABELS[s]}</option>
                                  ))}
                                </select>
                                <button type="submit" className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">Set</button>
                              </form>
                              <form action={deleteCopy}>
                                <input type="hidden" name="copyId" value={copy.id} />
                                <input type="hidden" name="resourceId" value={resource.id} />
                                <button type="submit" className="rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50">Delete</button>
                              </form>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Edit details */}
      <EditResourceSection resource={resource} categories={categories} />

      <MarcRecordSection
        resourceId={resource.id}
        fields={resource.marcFields}
        tagDefs={tagDefs}
      />

      {/* Merge duplicates */}
      <Card className="mt-6 p-5">
        <h2 className="font-display text-lg font-semibold">Merge a duplicate into this record</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          If the same title was catalogued twice, fold the other copy of the
          record into this one. Everything attached to it moves across and you
          see the full plan before confirming.
        </p>
        <Link
          href={`/admin/catalogue/merge?winner=${resource.id}`}
          className="mt-3 inline-flex items-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          Merge into this record
        </Link>
      </Card>

      {/* Danger zone */}
      <Card className="mt-6 border-red-200 p-5">
        <h2 className="font-display text-lg font-semibold text-red-700">Delete title</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Removes the title, its copies, and its loan/hold history. Not allowed while copies are on loan.
        </p>
        <form action={deleteResource} className="mt-3">
          <input type="hidden" name="id" value={resource.id} />
          <SubmitButton variant="danger" pendingLabel="Deleting…">Delete this title</SubmitButton>
        </form>
      </Card>
    </div>
  );
}
