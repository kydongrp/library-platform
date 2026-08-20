import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { applyGlobalChange } from "@/app/actions/marc";
import {
  previewChange, OPERATIONS, OPERATION_LABELS, GLOBAL_CHANGE_CAP,
  type Operation,
} from "@/lib/marc-global";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  operation?: string; tag?: string; subfieldCode?: string;
  findText?: string; replaceText?: string; addCode?: string; matchCase?: string;
}>;

export default async function GlobalChangePage({ searchParams }: { searchParams: SearchParams }) {
  const admin = await requireAdminView("CATALOGUE");
  const editable = canEdit(admin, "CATALOGUE");
  const sp = await searchParams;

  const operation = ((OPERATIONS as readonly string[]).includes(sp.operation ?? "")
    ? sp.operation
    : "REPLACE") as Operation;
  const spec = {
    operation,
    tag: (sp.tag ?? "").toUpperCase().slice(0, 3),
    subfieldCode: (sp.subfieldCode ?? "").slice(0, 1),
    findText: sp.findText ?? "",
    replaceText: sp.replaceText ?? "",
    addCode: (sp.addCode ?? "").slice(0, 1),
    matchCase: sp.matchCase === "on",
  };
  const hasQuery = spec.tag.length === 3;

  const [preview, tagDefs, history] = await Promise.all([
    hasQuery ? previewChange(spec) : Promise.resolve(null),
    prisma.marcTagDef.findMany({ orderBy: { sortOrder: "asc" }, select: { tag: true, label: true } }),
    prisma.marcChangeLog.findMany({ orderBy: { ranAt: "desc" }, take: 10 }),
  ]);

  const inputCls =
    "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
  const lbl = "mb-1 block text-xs font-medium text-muted-foreground";

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/admin/catalogue" className="text-sm text-muted-foreground hover:text-foreground">
        Back to catalogue
      </Link>

      <div className="mb-6 mt-3">
        <h1 className="font-display text-3xl font-semibold">Global change tags</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Edit one MARC tag across many records at once: rewrite text inside a
          subfield, add a subfield to every matching field, or remove the field
          entirely. You always see the affected records before anything is
          written, each run is capped at {GLOBAL_CHANGE_CAP.toLocaleString()} fields,
          and there is no undo, so every run is logged with a sample of the old values.
        </p>
      </div>

      {/* The spec */}
      <Card className="mb-6 p-5">
        <form className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_6rem_6rem]">
            <div>
              <label htmlFor="gc-op" className={lbl}>Operation</label>
              <select id="gc-op" name="operation" defaultValue={operation} className={inputCls}>
                {OPERATIONS.map((o) => (
                  <option key={o} value={o}>{OPERATION_LABELS[o]}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="gc-tag" className={lbl}>Tag *</label>
              <input id="gc-tag" name="tag" defaultValue={spec.tag} maxLength={3}
                list="gc-tags" placeholder="650" className={`${inputCls} font-mono`} />
            </div>
            <div>
              <label htmlFor="gc-sf" className={lbl}>In subfield</label>
              <input id="gc-sf" name="subfieldCode" defaultValue={spec.subfieldCode} maxLength={1}
                placeholder="any" className={`${inputCls} text-center font-mono`} />
            </div>
          </div>
          <datalist id="gc-tags">
            {tagDefs.map((d) => <option key={d.tag} value={d.tag}>{d.label}</option>)}
          </datalist>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="gc-find" className={lbl}>
                Find text {operation === "REPLACE" ? "*" : "(blank matches every instance of the tag)"}
              </label>
              <input id="gc-find" name="findText" defaultValue={spec.findText} maxLength={500} className={inputCls} />
            </div>
            <div>
              <label htmlFor="gc-rep" className={lbl}>
                {operation === "ADD_SUBFIELD" ? "New subfield value" : "Replace with (blank deletes the text)"}
              </label>
              <input id="gc-rep" name="replaceText" defaultValue={spec.replaceText} maxLength={500}
                disabled={operation === "DELETE_FIELD"} className={inputCls} />
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            {operation === "ADD_SUBFIELD" && (
              <div className="w-24">
                <label htmlFor="gc-add" className={lbl}>Subfield to add *</label>
                <input id="gc-add" name="addCode" defaultValue={spec.addCode} maxLength={1}
                  placeholder="2" className={`${inputCls} text-center font-mono`} />
              </div>
            )}
            <label className="flex items-center gap-1.5 pb-2 text-sm">
              <input type="checkbox" name="matchCase" defaultChecked={spec.matchCase}
                className="h-4 w-4 rounded border-border accent-primary" />
              Match case
            </label>
            <button type="submit"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
              Preview change
            </button>
            {hasQuery && (
              <Link href="/admin/catalogue/global-change" className="px-2 py-2 text-sm text-muted-foreground hover:text-foreground">
                Clear
              </Link>
            )}
          </div>
        </form>
      </Card>

      {/* Preview */}
      {preview?.error && (
        <p className="mb-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{preview.error}</p>
      )}

      {preview && !preview.error && (
        <Card className="mb-6 p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-semibold">
              {preview.changing === 0
                ? "Nothing matches"
                : `${preview.changing.toLocaleString()} field${preview.changing === 1 ? "" : "s"} would change`}
            </h2>
            {preview.capped && (
              <Badge tone="accent">
                capped at {GLOBAL_CHANGE_CAP.toLocaleString()} per run
              </Badge>
            )}
          </div>

          {preview.changing === 0 ? (
            <p className="text-sm text-muted-foreground">
              No field with tag {spec.tag} matches that text. Adjust the search and preview again.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Record</th>
                      <th className="px-3 py-2 font-medium">Now</th>
                      <th className="px-3 py-2 font-medium">After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.hits.map((h) => (
                      <tr key={h.fieldId} className="border-b border-border last:border-0">
                        <td className="px-3 py-2">
                          <Link href={`/admin/catalogue/${h.resourceId}`} className="hover:underline">
                            {h.title}
                          </Link>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{h.before}</td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {h.after === "(field deleted)" ? (
                            <span className="text-red-700">{h.after}</span>
                          ) : h.after}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.changing > preview.hits.length && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Showing the first {preview.hits.length} of {preview.changing.toLocaleString()}.
                </p>
              )}

              {editable && (
                <div className="mt-4">
                  <ActionButton
                    action={applyGlobalChange}
                    fields={{
                      operation: spec.operation,
                      tag: spec.tag,
                      subfieldCode: spec.subfieldCode,
                      findText: spec.findText,
                      replaceText: spec.replaceText,
                      addCode: spec.addCode,
                      ...(spec.matchCase ? { matchCase: "on" } : {}),
                    }}
                    variant="danger"
                    pendingLabel="Applying…"
                    confirm={`Apply this change to ${preview.changing} field(s)? There is no undo.`}
                  >
                    Apply to {preview.changing.toLocaleString()} field{preview.changing === 1 ? "" : "s"}
                  </ActionButton>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {/* Run history */}
      <Card className="p-5">
        <h2 className="mb-1 font-display text-lg font-semibold">Change history</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Written before each run, with a sample of the values as they were.
        </p>
        {history.length === 0 ? (
          <EmptyState title="No global changes yet" description="Runs are recorded here with what they affected." />
        ) : (
          <ul className="divide-y divide-border">
            {history.map((h) => (
              <li key={h.id} className="py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="neutral">{h.tag}{h.subfieldCode ? ` $${h.subfieldCode}` : ""}</Badge>
                  <span className="text-sm">{OPERATION_LABELS[h.operation as Operation] ?? h.operation}</span>
                  <Badge tone="primary">{h.changed} changed</Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {h.findText ? `"${h.findText}"` : "all instances"}
                  {h.replaceText ? ` to "${h.replaceText}"` : ""} · {h.runBy} · {formatDate(h.ranAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
