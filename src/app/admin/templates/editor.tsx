"use client";

import { StatefulForm, SubmitButton } from "@/components/forms";
import { Badge } from "@/components/ui";
import { updateTemplate } from "@/app/actions/admin-settings";
import { TEMPLATE_PLACEHOLDERS, placeholdersInUse } from "@/lib/template-defs";

type Template = {
  code: string;
  name: string;
  subject: string;
  body: string;
  inAppEnabled: boolean;
  emailEnabled: boolean;
};

const inputCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:bg-muted disabled:text-muted-foreground";

export function TemplateEditor({ template, readOnly }: { template: Template; readOnly: boolean }) {
  const placeholders = TEMPLATE_PLACEHOLDERS[template.code] ?? [];
  // Which of this notice's placeholders the current wording actually uses, so
  // the unused ones read as "also available" rather than as a flat list.
  const inUse = new Set(placeholdersInUse(template.subject, template.body));

  return (
    <StatefulForm action={updateTemplate}>
      <input type="hidden" name="code" value={template.code} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-lg font-semibold">{template.name}</h2>
          <Badge tone="muted">{template.code}</Badge>
        </div>
        {!readOnly && <SubmitButton variant="outline" pendingLabel="Saving…">Save</SubmitButton>}
      </div>

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor={`${template.code}-subject`}>
            Subject
          </label>
          <input id={`${template.code}-subject`} name="subject" defaultValue={template.subject}
            disabled={readOnly} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor={`${template.code}-body`}>
            Body
          </label>
          <textarea id={`${template.code}-body`} name="body" rows={4} defaultValue={template.body}
            disabled={readOnly} className={inputCls} />
        </div>
        <div className="flex flex-wrap items-center gap-5 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="inAppEnabled" defaultChecked={template.inAppEnabled} disabled={readOnly}
              className="h-4 w-4 rounded border-border accent-[var(--primary)]" />
            In-app notification
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="emailEnabled" defaultChecked={template.emailEnabled} disabled={readOnly}
              className="h-4 w-4 rounded border-border accent-[var(--primary)]" />
            Email (to outbox)
          </label>
          {placeholders.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="mr-0.5">This notice supplies:</span>
              {placeholders.map((p) => (
                <code
                  key={p}
                  title={inUse.has(p) ? "Used in this notice" : "Available, not currently used"}
                  className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
                    inUse.has(p)
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {`{{${p}}}`}
                </code>
              ))}
            </span>
          )}
        </div>
      </div>
    </StatefulForm>
  );
}
