import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import {
  deleteTagDef, restoreDefaultTags, deleteAuthority, deleteDomainOrTopic,
} from "@/app/actions/marc";
import {
  TagDefForm, AuthorityTypeForm, AuthorityForm, DomainForm, TopicForm,
} from "./widgets";

export const dynamic = "force-dynamic";

function subfieldSummary(raw: unknown): string {
  if (!Array.isArray(raw) || raw.length === 0) return "—";
  return raw
    .filter((s): s is { code?: unknown; label?: unknown } => !!s && typeof s === "object")
    .map((s) => `$${String(s.code ?? "")}`)
    .join(" ");
}

export default async function CataloguingPage() {
  const admin = await requireAdminView("CATALOGUE");
  const editable = canEdit(admin, "CATALOGUE");

  const [tagDefs, usage, authTypes, authorities, domains] = await Promise.all([
    prisma.marcTagDef.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.marcField.groupBy({ by: ["tag"], _count: { _all: true } }),
    prisma.authorityType.findMany({
      orderBy: { code: "asc" },
      include: { _count: { select: { authorities: true } } },
    }),
    prisma.authority.findMany({
      orderBy: { heading: "asc" },
      take: 100,
      include: { type: { select: { code: true } } },
    }),
    prisma.domainCode.findMany({ orderBy: { code: "asc" }, include: { topics: { orderBy: { name: "asc" } } } }),
  ]);

  const useCount = new Map(usage.map((u) => [u.tag, u._count._all]));
  const catalogued = usage.reduce((n, u) => n + u._count._all, 0);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Cataloguing</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          The MARC vocabulary behind the catalogue: which tags exist and what
          they carry, the controlled headings records point at, and the domain
          taxonomy the local 9XX tags reference. Records are catalogued on each
          bib record, under MARC record.
        </p>
      </div>

      {/* Information Context */}
      <Card className="mb-6 p-5">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">
            Information Context — MARC tags{" "}
            <Badge tone="muted">{tagDefs.length} defined</Badge>
          </h2>
          {editable && (
            <ActionButton action={restoreDefaultTags} fields={{}} variant="ghost"
              className="!px-2 !py-1 text-xs" pendingLabel="Restoring…">
              Restore missing defaults
            </ActionButton>
          )}
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          {catalogued.toLocaleString()} field{catalogued === 1 ? "" : "s"} catalogued across the collection.
          Tags in the 9XX block are local to this library; 00X are control fields with no indicators.
        </p>

        {tagDefs.length === 0 ? (
          <EmptyState title="No tag definitions" description="Restore the defaults to start with the MARC 21 core set." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-2 font-medium">Tag</th>
                  <th className="px-2 py-2 font-medium">Label</th>
                  <th className="px-2 py-2 font-medium">Alias</th>
                  <th className="px-2 py-2 font-medium">Subfields</th>
                  <th className="px-2 py-2 text-right font-medium">In use</th>
                  {editable && <th className="px-2 py-2"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {tagDefs.map((d) => (
                  <tr key={d.tag} className="border-b border-border last:border-0">
                    <td className="px-2 py-2 font-mono text-xs font-semibold">
                      {d.tag}
                      {d.local && <Badge tone="accent">local</Badge>}
                      {d.isControl && <Badge tone="muted">control</Badge>}
                    </td>
                    <td className="px-2 py-2">
                      {d.label}
                      {d.repeatable && <span className="ml-1 text-xs text-muted-foreground">· repeatable</span>}
                    </td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">{d.alias ?? "—"}</td>
                    <td className="px-2 py-2 font-mono text-xs text-muted-foreground">{subfieldSummary(d.subfields)}</td>
                    <td className="px-2 py-2 text-right" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {useCount.get(d.tag) ?? 0}
                    </td>
                    {editable && (
                      <td className="px-2 py-2 text-right">
                        <ActionButton action={deleteTagDef} fields={{ tag: d.tag }} variant="ghost"
                          className="!px-2 !py-1 text-xs text-red-700" pendingLabel="…"
                          confirm={`Delete the definition for ${d.tag}?`}>
                          Delete
                        </ActionButton>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editable && (
          <div className="mt-4 border-t border-border pt-4">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Add or update a tag</p>
            <TagDefForm />
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Authorities */}
        <Card className="p-5">
          <h2 className="mb-1 font-display text-lg font-semibold">Authorities</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Controlled headings. A heading may carry an external linked-data URI
            (the live system points name authorities at OCLC WorldCat), which
            catalogued records reference from subfield $0.
          </p>

          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Types</p>
          {authTypes.length === 0 ? (
            <p className="mb-3 text-sm text-muted-foreground">None yet.</p>
          ) : (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {authTypes.map((t) => (
                <Badge key={t.id} tone="neutral">
                  {t.code} · {t.name}{t.marcTag ? ` (${t.marcTag})` : ""} · {t._count.authorities}
                </Badge>
              ))}
            </div>
          )}
          {editable && <div className="mb-4"><AuthorityTypeForm /></div>}

          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
            Headings {authorities.length >= 100 && "(first 100)"}
          </p>
          {authorities.length === 0 ? (
            <p className="text-sm text-muted-foreground">No headings yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {authorities.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      <span className="font-mono text-xs text-muted-foreground">{a.type.code}</span>{" "}
                      {a.heading}
                    </p>
                    {(a.seeAlso || a.uri) && (
                      <p className="truncate text-xs text-muted-foreground">
                        {a.seeAlso && `see also: ${a.seeAlso}`}
                        {a.seeAlso && a.uri && " · "}
                        {a.uri && (
                          <a href={a.uri} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                            linked data ↗
                          </a>
                        )}
                      </p>
                    )}
                  </div>
                  {editable && (
                    <ActionButton action={deleteAuthority} fields={{ id: a.id }} variant="ghost"
                      className="!px-2 !py-1 text-xs text-red-700" pendingLabel="…"
                      confirm={`Delete the heading "${a.heading}"?`}>
                      Delete
                    </ActionButton>
                  )}
                </li>
              ))}
            </ul>
          )}
          {editable && (
            <div className="mt-4 border-t border-border pt-4">
              <AuthorityForm types={authTypes.map((t) => ({ id: t.id, code: t.code, name: t.name }))} />
            </div>
          )}
        </Card>

        {/* Domain codes and interest topics */}
        <Card className="p-5">
          <h2 className="mb-1 font-display text-lg font-semibold">Domain codes &amp; interest topics</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            The subject taxonomy the local <span className="font-mono">953</span> (DomainCode) tag
            references. Interest topics hang off a domain.
          </p>
          {domains.length === 0 ? (
            <p className="text-sm text-muted-foreground">No domain codes yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {domains.map((d) => (
                <li key={d.id} className="py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm">
                      <span className="font-mono text-xs font-semibold">{d.code}</span> · {d.name}
                    </p>
                    {editable && (
                      <ActionButton action={deleteDomainOrTopic} fields={{ kind: "domain", id: d.id }}
                        variant="ghost" className="!px-2 !py-1 text-xs text-red-700" pendingLabel="…"
                        confirm={`Delete ${d.code} and its ${d.topics.length} topic(s)?`}>
                        Delete
                      </ActionButton>
                    )}
                  </div>
                  {d.topics.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {d.topics.map((t) => (
                        <span key={t.id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                          {t.name}
                          {editable && (
                            <ActionButton action={deleteDomainOrTopic} fields={{ kind: "topic", id: t.id }}
                              variant="ghost" className="!px-1 !py-0 text-[10px] text-red-700" pendingLabel="…">
                              ✕
                            </ActionButton>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {editable && (
            <div className="mt-4 grid gap-3 border-t border-border pt-4">
              <DomainForm />
              <TopicForm domains={domains.map((d) => ({ id: d.id, code: d.code, name: d.name }))} />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
