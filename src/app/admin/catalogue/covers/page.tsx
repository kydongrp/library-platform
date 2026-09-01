import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState, SectionHeading } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { setCoverImageEnabled, deleteCoverImage, backfillCoverImages } from "@/app/actions/covers";
import { knownMatchTargets } from "@/lib/cover-images";
import { describeToken, GENERAL_TOKENS } from "@/lib/cover-match";
import { formatDate } from "@/lib/format";
import { CoverUploadForm } from "./widgets";

export const dynamic = "force-dynamic";

/**
 * Common cover images: the pool of house covers used for records that arrive
 * with no cover art of their own.
 *
 * Cover art is bibliographic presentation, so this sits in the CATALOGUE area
 * alongside the records it decorates, and needs no new permission row.
 */
export default async function CoverImagesPage() {
  const admin = await requireAdminView("CATALOGUE");
  const editable = canEdit(admin, "CATALOGUE");

  const [images, targets, coverless, withCover] = await Promise.all([
    prisma.coverImage.findMany({
      // Never select `bytes` for a listing: the whole pool would be pulled into
      // memory to render a table of names.
      select: {
        id: true, fileName: true, token: true, mimeType: true, sizeBytes: true,
        enabled: true, uploadedBy: true, createdAt: true,
        _count: { select: { resources: true } },
      },
      orderBy: [{ enabled: "desc" }, { fileName: "asc" }],
    }),
    knownMatchTargets(),
    prisma.resource.count({ where: { coverImageId: null } }),
    prisma.resource.count({ where: { coverImageId: { not: null } } }),
  ]);

  const enabled = images.filter((i) => i.enabled);
  const hasGeneral = enabled.some((i) => !i.token || GENERAL_TOKENS.includes(i.token));
  // An image whose token names nothing live can never be assigned. Silence here
  // would leave staff believing an upload took effect when it cannot.
  const unused = enabled.filter((i) => describeToken(i.token, targets).scope === "unused");

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Common cover images</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          House covers for records that arrive without their own. One is assigned automatically as
          each record is imported: by collection, then by publisher, then a general image.
        </p>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-2xl font-semibold tabular-nums">{enabled.length}</p>
          <p className="text-sm text-muted-foreground">
            image{enabled.length === 1 ? "" : "s"} in the pool
            {images.length > enabled.length && ` (${images.length - enabled.length} retired)`}
          </p>
        </Card>
        <Card>
          <p className="text-2xl font-semibold tabular-nums">{withCover}</p>
          <p className="text-sm text-muted-foreground">records showing a common cover</p>
        </Card>
        <Card>
          <p className="text-2xl font-semibold tabular-nums">{coverless}</p>
          <p className="text-sm text-muted-foreground">records on the coloured placeholder</p>
        </Card>
      </div>

      {/*
        The single most useful warning on this screen. Without a general image,
        any record whose collection and publisher are unmatched gets no cover at
        all, which is deliberate (never a wrong cover) but surprises anyone who
        expected the pool to apply everywhere.
      */}
      {enabled.length > 0 && !hasGeneral && (
        <div className="mb-6 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">No general image in the pool.</p>
          <p className="mt-1">
            Records whose collection and publisher match nothing will keep the coloured placeholder
            rather than take a cover meant for another subject. Upload a file named{" "}
            <code className="rounded bg-amber-100 px-1">general-1.png</code> to cover the rest.
          </p>
        </div>
      )}

      {unused.length > 0 && (
        <div className="mb-6 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900">
          <p className="font-medium">
            {unused.length} image{unused.length === 1 ? "" : "s"} can never be assigned.
          </p>
          <p className="mt-1">
            {unused.map((i) => i.fileName).join(", ")} match no collection and no publisher, and are
            not named as general images. Rename the file to a collection or publisher below, or to{" "}
            <code className="rounded bg-red-100 px-1">general</code>, and upload it again.
          </p>
        </div>
      )}

      {editable && (
        <Card className="mb-6">
          <SectionHeading title="Upload images" />
          <CoverUploadForm collections={targets.collections} publishers={targets.publishers} />
        </Card>
      )}

      <Card className="mb-6">
        <SectionHeading
          title="The pool"
          subtitle="Retiring an image takes it out of future assignment; records already using it keep it."
        />
        {images.length === 0 ? (
          <EmptyState
            title="No cover images yet"
            description="Upload house covers named after the collections and publishers they serve, plus a general image for everything else."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Image</th>
                  <th className="py-2 pr-3 font-medium">File name</th>
                  <th className="py-2 pr-3 font-medium">Matches</th>
                  <th className="py-2 pr-3 font-medium">In use</th>
                  <th className="py-2 pr-3 font-medium">Added</th>
                  {editable && <th className="py-2 font-medium">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {images.map((img) => {
                  const { scope, matches } = describeToken(img.token, targets);
                  return (
                    <tr key={img.id} className="border-b border-border/60 last:border-0">
                      <td className="py-2 pr-3">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/covers/${img.id}`}
                          alt={`Cover image ${img.fileName}`}
                          className="h-14 w-10 rounded object-cover ring-1 ring-border"
                          loading="lazy"
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <p className="font-medium">{img.fileName}</p>
                        <p className="text-xs text-muted-foreground">
                          {img.mimeType.replace("image/", "").toUpperCase()} ·{" "}
                          {Math.max(1, Math.round(img.sizeBytes / 1000))}KB
                          {img.uploadedBy && ` · ${img.uploadedBy}`}
                        </p>
                      </td>
                      <td className="py-2 pr-3">
                        {scope === "general" && <Badge tone="muted">general</Badge>}
                        {scope === "unused" && (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <Badge tone="danger">never used</Badge>
                            <span className="text-xs text-red-700">
                              matches no collection or publisher
                            </span>
                          </span>
                        )}
                        {(scope === "collection" || scope === "publisher") && (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <Badge tone="primary">{scope}</Badge>
                            <span className="text-xs">{matches}</span>
                          </span>
                        )}
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          token &quot;{img.token || "(none)"}&quot;
                        </p>
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{img._count.resources}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {formatDate(img.createdAt)}
                        {!img.enabled && (
                          <span className="ml-1">
                            <Badge tone="muted">retired</Badge>
                          </span>
                        )}
                      </td>
                      {editable && (
                        <td className="py-2">
                          <div className="flex flex-wrap gap-1.5">
                            <ActionButton
                              action={setCoverImageEnabled}
                              fields={{ id: img.id, enabled: img.enabled ? "0" : "1" }}
                              variant="outline"
                              className="text-xs"
                            >
                              {img.enabled ? "Retire" : "Restore"}
                            </ActionButton>
                            <ActionButton
                              action={deleteCoverImage}
                              fields={{ id: img.id }}
                              variant="danger"
                              className="text-xs"
                              confirm={
                                img._count.resources > 0
                                  ? `Delete ${img.fileName}? ${img._count.resources} record(s) will go back to the coloured placeholder. Retiring keeps their cover.`
                                  : `Delete ${img.fileName}?`
                              }
                            >
                              Delete
                            </ActionButton>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editable && enabled.length > 0 && coverless > 0 && (
        <Card className="mb-6">
          <SectionHeading
            title="Apply to existing records"
            subtitle="Assignment happens at import, so records catalogued before this pool existed have no cover. This fills only records that have none, so it is safe to run more than once."
          />
          <ActionButton
            action={backfillCoverImages}
            fields={{}}
            pendingLabel="Assigning…"
            confirm={`Assign covers to up to 500 of the ${coverless} records with no cover image?`}
          >
            Assign covers to records with none
          </ActionButton>
        </Card>
      )}

      <Card>
        <SectionHeading
          title="Names that will match"
          subtitle="Name a file after one of these, with an optional trailing number, and it will be used for those records. Anything else becomes a general image."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Collections
            </p>
            <p className="text-sm">{targets.collections.join(" · ") || "None yet"}</p>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Publishers in the catalogue
            </p>
            <p className="text-sm">{targets.publishers.slice(0, 40).join(" · ") || "None yet"}</p>
            {targets.publishers.length > 40 && (
              <p className="mt-1 text-xs text-muted-foreground">
                and {targets.publishers.length - 40} more
              </p>
            )}
          </div>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          General names, used when nothing more specific matches:{" "}
          {GENERAL_TOKENS.map((t) => (
            <code key={t} className="mr-1 rounded bg-muted px-1">
              {t}
            </code>
          ))}
        </p>
      </Card>
    </div>
  );
}
