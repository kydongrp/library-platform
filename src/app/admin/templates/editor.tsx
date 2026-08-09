"use client";

import { StatefulForm, SubmitButton } from "@/components/forms";
import { Badge } from "@/components/ui";
import { updateTemplate } from "@/app/actions/admin-settings";
import { TEMPLATE_PLACEHOLDERS } from "@/lib/template-defs";

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
            <span className="text-xs text-muted-foreground">
              Placeholders: {placeholders.map((p) => `{{${p}}}`).join(", ")}
            </span>
          )}
        </div>
      </div>
    </StatefulForm>
  );
}
