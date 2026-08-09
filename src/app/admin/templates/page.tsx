import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { Card } from "@/components/ui";
import { TemplateEditor } from "./editor";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const admin = await requireAdminView("TEMPLATES");
  const editable = canEdit(admin, "TEMPLATES");

  const templates = await prisma.emailTemplate.findMany({ orderBy: { name: "asc" } });

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Email Templates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          System notifications sent by circulation events and the end-of-day
          batch. Placeholders like {"{{memberName}}"} are substituted when the
          notice is generated. In-app notices go to the member&apos;s Notification
          Centre; email notices go to the mail outbox.
        </p>
      </div>

      {!editable && (
        <p className="mb-5 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Your group has read-only access to templates.
        </p>
      )}

      <div className="grid gap-4">
        {templates.map((t) => (
          <Card key={t.id} className="p-5">
            <TemplateEditor template={t} readOnly={!editable} />
          </Card>
        ))}
      </div>
    </div>
  );
}
