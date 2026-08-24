import { prisma } from "@/lib/db";
import { daysBetweenInstants, zonedDayRange } from "@/lib/tz";
import { formatDate } from "@/lib/format";
import { formatFine } from "@/lib/fines";
import { getAccruingFines } from "@/lib/loan-history";
import { poTotalCents } from "@/lib/acquisitions";
import { FREQUENCY_LABELS, isLate, type Frequency } from "@/lib/serials-shared";
import { MATERIAL_DESIGNATION_LABELS, MEMBER_TYPE_LABELS } from "@/lib/constants";
import type { ReportCriteria, ReportResult } from "@/lib/reports";

/**
 * Per-module reports (SDD rows 73, 76, 78, and the extra loan report types the
 * comparison asks for under row 75). Kept in their own module so the five
 * original standard reports stay untouched; `runReport` falls through to
 * `runModuleReport` for any key it does not recognise.
 */
export const MODULE_REPORTS = [
  {
    key: "loans-fines",
    group: "Loans",
    name: "Fines ledger",
    description: "Every fine accruing, outstanding, paid or waived, with the loan that caused it.",
    dateField: "loan due date",
  },
  {
    key: "items-inventory",
    group: "Items",
    name: "Item inventory",
    description: "Every physical copy with its collection, location, item type and current holder.",
    dateField: null,
  },
  {
    key: "items-weeded",
    group: "Items",
    name: "Weeding log",
    description: "Copies withdrawn from the shelves, with the reason and who withdrew them.",
    dateField: "date withdrawn",
  },
  {
    key: "acq-budget",
    group: "Acquisitions",
    name: "Fund utilisation",
    description: "Allocation against open orders and invoices for each fund, by fiscal year.",
    dateField: null,
  },
  {
    key: "acq-orders",
    group: "Acquisitions",
    name: "Purchase orders",
    description: "Orders with supplier, fund, line count and how much has been received.",
    dateField: "order date",
  },
  {
    key: "acq-invoices",
    group: "Acquisitions",
    name: "Invoices",
    description: "Supplier invoices against funds and orders, with payment state.",
    dateField: "invoice date",
  },
  {
    key: "serials-subscriptions",
    group: "Serials",
    name: "Subscription holdings",
    description: "One row per serial: pattern, issues received, what is late, what is next.",
    dateField: null,
  },
  {
    key: "serials-issues",
    group: "Serials",
    name: "Issue arrivals",
    description: "Issue-level receipt record, including lateness and claims sent.",
    dateField: "expected date",
  },
] as const;

export type ModuleReportKey = (typeof MODULE_REPORTS)[number]["key"];

/** Keys whose rows are filtered by the from/to criteria. */
export const DATE_RANGED_MODULE_REPORTS: string[] = MODULE_REPORTS.filter((r) => r.dateField).map(
  (r) => r.key,
);

const DASH = "—";

/**
 * Row ceiling for the record-level reports. These grow with the collection
 * rather than with a code list, so an unbounded query would eventually try to
 * materialise the whole item file. Truncation is always reported, never silent.
 */
export const MODULE_ROW_CAP = 10_000;

function capNote(
  rows: unknown[],
  what: string,
  advice = "Narrow the date range to see the rest.",
): string | undefined {
  return rows.length >= MODULE_ROW_CAP
    ? `Showing the first ${MODULE_ROW_CAP.toLocaleString()} ${what}, and the export is capped to the same rows. ${advice}`
    : undefined;
}

/**
 * Whole CALENDAR days from `a` to `b` in the library's zone, floored at zero.
 *
 * Was elapsed milliseconds over a day, which reports a different days-late
 * figure from the fine calculation for the same loan, because that counts
 * calendar days.
 */
function daysBetween(a: Date, b: Date): number {
  return Math.max(0, daysBetweenInstants(a, b));
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return DASH;
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * Run a module report. Returns null for an unknown key so the caller can keep
 * its own fallback behaviour.
 */
export async function runModuleReport(key: string, c: ReportCriteria): Promise<ReportResult | null> {
  // Zoned bounds, `to` inclusive of the whole day the user picked. See
  // zonedDayRange: the previous UTC-midnight bounds were 08:00 Singapore.
  const { gte: from, lt: to } = zonedDayRange(c.from, c.to);
  const range = from || to ? { ...(from && { gte: from }), ...(to && { lt: to }) } : undefined;
  const now = new Date();

  switch (key) {
    /* ---------------------------------------------------------- Loans ---- */
    case "loans-fines": {
      // Two populations: fines already assessed at check-in, and fines still
      // accruing on loans that are overdue right now.
      const [assessed, accruing] = await Promise.all([
        prisma.loan.findMany({
          where: { fineCents: { gt: 0 }, ...(range && { dueAt: range }) },
          include: {
            resource: { select: { title: true } },
            member: { select: { name: true, memberType: true } },
          },
          orderBy: { dueAt: "desc" },
          take: MODULE_ROW_CAP,
        }),
        getAccruingFines(now),
      ]);

      const rows = assessed.map((l) => {
        const state = l.fineWaivedAt ? "Waived" : l.finePaidAt ? "Paid" : "Outstanding";
        const settled = l.fineWaivedAt ?? l.finePaidAt;
        return {
          sort: l.dueAt.getTime(),
          cells: [
            l.resource.title,
            l.member.name,
            MEMBER_TYPE_LABELS[l.member.memberType] ?? l.member.memberType,
            formatDate(l.dueAt),
            l.returnedAt ? formatDate(l.returnedAt) : DASH,
            l.returnedAt ? String(daysBetween(l.dueAt, l.returnedAt)) : DASH,
            formatFine(l.fineCents),
            state,
            settled ? formatDate(settled) : DASH,
          ],
        };
      });

      // An accruing loan has no assessed fine yet, so the two sets cannot overlap.
      for (const a of accruing) {
        if (a.accruedCents <= 0) continue;
        if (range) {
          if (from && a.dueAt < from) continue;
          if (to && a.dueAt >= to) continue;
        }
        rows.push({
          sort: a.dueAt.getTime(),
          cells: [
            a.title,
            a.memberName,
            DASH,
            formatDate(a.dueAt),
            DASH,
            String(a.daysLate),
            formatFine(a.accruedCents),
            "Accruing",
            DASH,
          ],
        });
      }

      rows.sort((x, y) => y.sort - x.sort);
      return {
        columns: [
          "Title",
          "Member",
          "Member type",
          "Due",
          "Returned",
          "Days late",
          "Fine",
          "State",
          "Settled",
        ],
        rows: rows.map((r) => r.cells),
        note: capNote(assessed, "fines"),
      };
    }

    /* ---------------------------------------------------------- Items ---- */
    case "items-inventory": {
      const copies = await prisma.copy.findMany({
        include: {
          resource: { select: { title: true, materialDesignation: true } },
          collection: { select: { name: true } },
          itemLocation: { select: { name: true } },
          itemType: { select: { name: true, loanable: true } },
          loans: {
            where: { status: "ACTIVE" },
            include: { member: { select: { name: true } } },
            orderBy: { borrowedAt: "desc" },
            take: 1,
          },
        },
        orderBy: [{ resource: { title: "asc" } }, { barcode: "asc" }],
        take: MODULE_ROW_CAP,
      });
      return {
        columns: [
          "Barcode",
          "Title",
          "Designation",
          "Collection",
          "Location",
          "Item type",
          "Loanable",
          "Status",
          "On loan to",
          "Due",
        ],
        rows: copies.map((cp) => {
          const loan = cp.loans[0];
          return [
            cp.barcode,
            cp.resource.title,
            MATERIAL_DESIGNATION_LABELS[cp.resource.materialDesignation] ??
              cp.resource.materialDesignation,
            cp.collection?.name ?? DASH,
            // Falls back to the legacy free-text shelf for copies catalogued
            // before the location code list existed.
            cp.itemLocation?.name ?? cp.location,
            cp.itemType?.name ?? DASH,
            cp.itemType ? (cp.itemType.loanable ? "Yes" : "Reference only") : DASH,
            cp.status.charAt(0) + cp.status.slice(1).toLowerCase().replace(/_/g, " "),
            loan?.member.name ?? DASH,
            loan ? formatDate(loan.dueAt) : DASH,
          ];
        }),
        note: capNote(copies, "items", "Use the Items module to browse a specific collection or location."),
      };
    }

    case "items-weeded": {
      const logs = await prisma.itemWeedLog.findMany({
        where: { ...(range && { weededAt: range }) },
        orderBy: { weededAt: "desc" },
        take: MODULE_ROW_CAP,
      });
      return {
        columns: ["Withdrawn", "Barcode", "Title", "Reason", "Collection", "Location", "By"],
        rows: logs.map((l) => [
          formatDate(l.weededAt),
          l.barcode,
          l.title,
          l.reason,
          l.collection ?? DASH,
          l.location ?? DASH,
          l.weededBy,
        ]),
        note: capNote(logs, "withdrawals"),
      };
    }

    /* --------------------------------------------------- Acquisitions ---- */
    case "acq-budget": {
      const funds = await prisma.acqFund.findMany({
        include: {
          orders: {
            include: { lines: true, invoices: { select: { id: true } } },
          },
          invoices: { select: { amountCents: true, status: true } },
        },
        orderBy: [{ fiscalYear: "desc" }, { name: "asc" }],
      });
      return {
        columns: [
          "Fiscal year",
          "Fund",
          "Allocated",
          "On order",
          "Invoiced",
          "Paid",
          "Remaining",
          "Utilised",
        ],
        rows: funds.map((f) => {
          // On order counts live orders that have not been invoiced yet, so an
          // order and its invoice are never charged to the fund twice.
          const onOrder = f.orders
            .filter(
              (o) =>
                (o.status === "ORDERED" || o.status === "RECEIVED") && o.invoices.length === 0,
            )
            .reduce((sum, o) => sum + poTotalCents(o.lines), 0);
          const invoiced = f.invoices.reduce((sum, i) => sum + i.amountCents, 0);
          const paid = f.invoices
            .filter((i) => i.status === "PAID")
            .reduce((sum, i) => sum + i.amountCents, 0);
          const committed = onOrder + invoiced;
          return [
            f.fiscalYear,
            f.name,
            formatFine(f.amountCents, f.currency),
            formatFine(onOrder, f.currency),
            formatFine(invoiced, f.currency),
            formatFine(paid, f.currency),
            formatFine(f.amountCents - committed, f.currency),
            pct(committed, f.amountCents),
          ];
        }),
      };
    }

    case "acq-orders": {
      const orders = await prisma.purchaseOrder.findMany({
        where: { ...(range && { orderedAt: range }) },
        include: { supplier: true, fund: true, lines: true },
        orderBy: { orderedAt: "desc" },
        take: MODULE_ROW_CAP,
      });
      return {
        columns: [
          "PO number",
          "Ordered",
          "Supplier",
          "Fund",
          "Status",
          "Lines",
          "Qty ordered",
          "Qty received",
          "Total",
          "Raised by",
        ],
        rows: orders.map((o) => {
          const qty = o.lines.reduce((s, l) => s + l.qty, 0);
          const received = o.lines.reduce((s, l) => s + l.receivedQty, 0);
          return [
            o.poNumber,
            formatDate(o.orderedAt),
            o.supplier.name,
            `${o.fund.fiscalYear} ${o.fund.name}`,
            o.status.charAt(0) + o.status.slice(1).toLowerCase(),
            String(o.lines.length),
            String(qty),
            String(received),
            formatFine(poTotalCents(o.lines), o.fund.currency),
            o.orderedBy,
          ];
        }),
        note: capNote(orders, "orders"),
      };
    }

    case "acq-invoices": {
      const invoices = await prisma.invoice.findMany({
        where: { ...(range && { invoiceDate: range }) },
        include: { supplier: true, fund: true, po: { select: { poNumber: true } } },
        orderBy: { invoiceDate: "desc" },
        take: MODULE_ROW_CAP,
      });
      return {
        columns: ["Invoice", "Date", "Supplier", "Order", "Fund", "Amount", "Status", "Paid"],
        rows: invoices.map((i) => [
          i.invoiceNumber,
          formatDate(i.invoiceDate),
          i.supplier.name,
          i.po?.poNumber ?? DASH,
          `${i.fund.fiscalYear} ${i.fund.name}`,
          formatFine(i.amountCents, i.fund.currency),
          i.status === "PAID" ? "Paid" : "Pending",
          i.paidAt ? formatDate(i.paidAt) : DASH,
        ]),
        note: capNote(invoices, "invoices"),
      };
    }

    /* -------------------------------------------------------- Serials ---- */
    case "serials-subscriptions": {
      const serials = await prisma.serial.findMany({
        include: {
          resource: { select: { title: true } },
          issues: {
            select: { status: true, expectedAt: true, receivedAt: true, claimedAt: true },
          },
        },
        orderBy: { resource: { title: "asc" } },
      });
      return {
        columns: [
          "Title",
          "ISSN",
          "Pattern",
          "Status",
          "Issues received",
          "Awaiting",
          "Late",
          "Claims sent",
          "Next expected",
          "Last received",
          "Vendor contact",
        ],
        rows: serials.map((s) => {
          const received = s.issues.filter((i) => i.status === "RECEIVED");
          const awaiting = s.issues.filter((i) => i.status === "EXPECTED");
          const late = awaiting.filter((i) => isLate(i, now));
          const claims = s.issues.filter((i) => i.claimedAt).length;
          const next = awaiting
            .map((i) => i.expectedAt)
            .sort((a, b) => a.getTime() - b.getTime())[0];
          const last = received
            .map((i) => i.receivedAt)
            .filter((d): d is Date => !!d)
            .sort((a, b) => b.getTime() - a.getTime())[0];
          return [
            s.resource.title,
            s.issn ?? DASH,
            FREQUENCY_LABELS[s.frequency as Frequency] ?? s.frequency,
            s.status.charAt(0) + s.status.slice(1).toLowerCase(),
            String(received.length),
            String(awaiting.length),
            String(late.length),
            String(claims),
            next ? formatDate(next) : DASH,
            last ? formatDate(last) : DASH,
            s.claimEmail ?? "not set",
          ];
        }),
      };
    }

    case "serials-issues": {
      const issues = await prisma.serialIssue.findMany({
        where: { ...(range && { expectedAt: range }) },
        include: { serial: { include: { resource: { select: { title: true } } } } },
        orderBy: [{ expectedAt: "desc" }],
        take: MODULE_ROW_CAP,
      });
      return {
        columns: ["Title", "Issue", "Expected", "Status", "Received", "Days late", "Claimed"],
        rows: issues.map((i) => {
          // Lateness is only meaningful while an issue is still outstanding;
          // a received issue reports the gap it actually arrived in.
          const daysLate =
            i.status === "RECEIVED" && i.receivedAt
              ? daysBetween(i.expectedAt, i.receivedAt)
              : i.status === "EXPECTED"
                ? daysBetween(i.expectedAt, now)
                : 0;
          return [
            i.serial.resource.title,
            i.label,
            formatDate(i.expectedAt),
            i.status.charAt(0) + i.status.slice(1).toLowerCase(),
            i.receivedAt ? formatDate(i.receivedAt) : DASH,
            daysLate > 0 ? String(daysLate) : DASH,
            i.claimedAt ? formatDate(i.claimedAt) : DASH,
          ];
        }),
        note: capNote(issues, "issues"),
      };
    }

    default:
      return null;
  }
}
