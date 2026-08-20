import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { RESOURCE_TYPE_LABELS, MEMBER_TYPE_LABELS } from "@/lib/constants";
import { runModuleReport } from "@/lib/reports-modules";

export const REPORTS = [
  { key: "loans", group: "Loans", name: "Loans by period", description: "All loans started in a date range, with member and return details." },
  { key: "overdue", group: "Loans", name: "Overdue loans", description: "Active loans past their due date, oldest first." },
  { key: "reservations", group: "Loans", name: "Reservations", description: "All active holds with queue position." },
  { key: "member-activity", group: "Members", name: "Member activity", description: "Loan and reservation counts per member." },
  { key: "inventory", group: "Catalogue", name: "Catalogue inventory", description: "Every title with copy counts and availability." },
] as const;
export type ReportKey = (typeof REPORTS)[number]["key"];

export type ReportCriteria = { from?: string; to?: string; memberType?: string };
export type ReportResult = {
  columns: string[];
  rows: string[][];
  /** Set when the row cap truncated the result, so the page can say so. */
  note?: string;
};

/** Run a standard report and return a flat table (shared by page and CSV export). */
export async function runReport(key: string, c: ReportCriteria): Promise<ReportResult> {
  const from = c.from ? new Date(c.from) : undefined;
  const to = c.to ? new Date(new Date(c.to).getTime() + 24 * 60 * 60 * 1000) : undefined;

  switch (key) {
    case "loans": {
      const loans = await prisma.loan.findMany({
        where: {
          borrowedAt: { ...(from && { gte: from }), ...(to && { lt: to }) },
          ...(c.memberType && { member: { memberType: c.memberType } }),
        },
        include: { member: true, resource: true, copy: true },
        orderBy: { borrowedAt: "desc" },
      });
      return {
        columns: ["Borrowed", "Title", "Member", "Type", "Copy", "Due", "Returned", "Status"],
        rows: loans.map((l) => [
          formatDate(l.borrowedAt),
          l.resource.title,
          l.member.name,
          MEMBER_TYPE_LABELS[l.member.memberType] ?? l.member.memberType,
          l.copy?.barcode ?? "digital",
          formatDate(l.dueAt),
          l.returnedAt ? formatDate(l.returnedAt) : "—",
          l.status,
        ]),
      };
    }
    case "overdue": {
      const loans = await prisma.loan.findMany({
        where: {
          status: "ACTIVE",
          dueAt: { lt: new Date() },
          ...(c.memberType && { member: { memberType: c.memberType } }),
        },
        include: { member: true, resource: true, copy: true },
        orderBy: { dueAt: "asc" },
      });
      const now = Date.now();
      return {
        columns: ["Title", "Member", "Email", "Copy", "Due", "Days overdue"],
        rows: loans.map((l) => [
          l.resource.title,
          l.member.name,
          l.member.email,
          l.copy?.barcode ?? "digital",
          formatDate(l.dueAt),
          String(Math.floor((now - l.dueAt.getTime()) / 86400000)),
        ]),
      };
    }
    case "inventory": {
      const resources = await prisma.resource.findMany({
        include: { copies: true, _count: { select: { loans: true } } },
        orderBy: { title: "asc" },
      });
      return {
        columns: ["Title", "Author", "Type", "Category", "Source", "Copies", "Available", "Lifetime loans"],
        rows: resources.map((r) => [
          r.title,
          r.author,
          RESOURCE_TYPE_LABELS[r.type] ?? r.type,
          r.category,
          r.provider ?? "Local",
          String(r.copies.length),
          String(r.copies.filter((cp) => cp.status === "AVAILABLE").length),
          String(r._count.loans),
        ]),
      };
    }
    case "member-activity": {
      const members = await prisma.member.findMany({
        where: c.memberType ? { memberType: c.memberType } : undefined,
        include: {
          loans: true,
          _count: { select: { reservations: true } },
        },
        orderBy: { name: "asc" },
      });
      return {
        columns: ["Member", "Email", "Type", "Status", "Active loans", "Total loans", "Reservations", "Joined"],
        rows: members.map((m) => [
          m.name,
          m.email,
          MEMBER_TYPE_LABELS[m.memberType] ?? m.memberType,
          m.status,
          String(m.loans.filter((l) => l.status === "ACTIVE").length),
          String(m.loans.length),
          String(m._count.reservations),
          formatDate(m.joinedAt),
        ]),
      };
    }
    case "reservations": {
      const holds = await prisma.reservation.findMany({
        where: { status: { in: ["PENDING", "READY"] } },
        include: { member: true, resource: true },
        orderBy: [{ resourceId: "asc" }, { reservedAt: "asc" }],
      });
      const positions = new Map<string, number>();
      return {
        columns: ["Title", "Member", "Placed", "Status", "Queue position"],
        rows: holds.map((h) => {
          const pos = (positions.get(h.resourceId) ?? 0) + 1;
          positions.set(h.resourceId, pos);
          return [
            h.resource.title,
            h.member.name,
            formatDate(h.reservedAt),
            h.status === "READY" ? "Ready for pickup" : "Waiting",
            String(pos),
          ];
        }),
      };
    }
    default:
      return (await runModuleReport(key, c)) ?? { columns: [], rows: [] };
  }
}

export function toCsv(result: ReportResult): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [result.columns, ...result.rows].map((r) => r.map(esc).join(",")).join("\r\n");
}
