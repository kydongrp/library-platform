import { prisma } from "@/lib/db";
import { renderTemplate, type TemplateVars } from "@/lib/template-defs";

export { renderTemplate, TEMPLATE_PLACEHOLDERS, DEFAULT_TEMPLATES, type TemplateVars } from "@/lib/template-defs";

/**
 * Fire a notification through a template: writes an in-app Notification when
 * the template has in-app enabled, and queues a MailQueue row when email is
 * enabled. Silently no-ops if the template is missing.
 */
export async function notify(
  code: string,
  member: { id: string; name: string; email: string },
  vars: TemplateVars,
): Promise<void> {
  const template = await prisma.emailTemplate.findUnique({ where: { code } });
  if (!template) return;
  const allVars = { memberName: member.name, ...vars };
  const subject = renderTemplate(template.subject, allVars);
  const body = renderTemplate(template.body, allVars);

  if (template.inAppEnabled) {
    await prisma.notification.create({
      data: { type: code, title: subject, body, memberId: member.id },
    });
  }
  if (template.emailEnabled) {
    // QUEUED, not SENT. This used to write SENT immediately with a comment
    // saying the send was simulated, which meant the outbox reported success
    // for mail nobody received. The scheduled drain in lib/mail/queue.ts is
    // what moves a row to SENT now, and only after a provider accepted it.
    //
    // Enqueue and return: sending inline would put an external service in the
    // path of a checkout, so a slow provider would become a slow desk.
    await prisma.mailQueue.create({
      data: {
        toEmail: member.email,
        toName: member.name,
        subject,
        body,
        template: code,
        status: "QUEUED",
      },
    });
  }
}
