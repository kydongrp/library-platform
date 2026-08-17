// Acquisitions (SDD): suppliers, fiscal-year funds, purchase orders, and
// invoices. Budget positions are always DERIVED, never stored:
//   committed = open POs (ORDERED / RECEIVED)  — money promised
//   spent     = PAID invoices                  — money gone
//   available = fund amount − committed − spent
// A PO stops committing when CANCELLED, or when it CLOSEs (fully received
// and its invoice paid) — at which point the paid invoice carries the cost.

import { prisma } from "@/lib/db";

export const PO_STATUSES = ["ORDERED", "RECEIVED", "CLOSED", "CANCELLED"] as const;
const COMMITTING = ["ORDERED", "RECEIVED"];

export function poTotalCents(lines: { qty: number; unitCents: number }[]): number {
  return lines.reduce((sum, l) => sum + l.qty * l.unitCents, 0);
}

/** Next PO number for the year, e.g. "PO-2026-0007". Caller retries on P2002. */
export async function nextPoNumber(now = new Date()): Promise<string> {
  const year = now.getUTCFullYear();
  const count = await prisma.purchaseOrder.count({
    where: { poNumber: { startsWith: `PO-${year}-` } },
  });
  return `PO-${year}-${String(count + 1).padStart(4, "0")}`;
}

export type FundRow = {
  id: string;
  fiscalYear: string;
  name: string;
  currency: string;
  amountCents: number;
  committedCents: number;
  spentCents: number;
  availableCents: number;
};

export type PoRow = {
  id: string;
  poNumber: string;
  supplier: string;
  fund: string;
  status: string;
  orderedAt: Date;
  orderedBy: string;
  notes: string | null;
  totalCents: number;
  currency: string;
  lines: { id: string; title: string; qty: number; unitCents: number; receivedQty: number }[];
  invoiced: boolean;
};

export type InvoiceRow = {
  id: string;
  invoiceNumber: string;
  supplier: string;
  fund: string;
  poNumber: string | null;
  amountCents: number;
  currency: string;
  invoiceDate: Date;
  status: string;
  paidAt: Date | null;
};

export type AcquisitionsOverview = {
  funds: FundRow[];
  fiscalYears: string[];
  suppliers: { id: string; name: string; email: string | null; contact: string | null; status: string; openOrders: number }[];
  orders: PoRow[]; // open first, newest first within group
  invoices: InvoiceRow[]; // pending first
  totals: { budgetCents: number; committedCents: number; spentCents: number; pendingInvoiceCents: number; currency: string };
};

export async function getAcquisitionsOverview(): Promise<AcquisitionsOverview> {
  const [funds, suppliers, orders, invoices] = await Promise.all([
    prisma.acqFund.findMany({ orderBy: [{ fiscalYear: "desc" }, { name: "asc" }] }),
    prisma.supplier.findMany({ orderBy: { name: "asc" } }),
    prisma.purchaseOrder.findMany({
      include: {
        supplier: { select: { name: true } },
        fund: { select: { name: true, currency: true } },
        lines: true,
        invoices: { select: { id: true } },
      },
      orderBy: { orderedAt: "desc" },
      take: 100,
    }),
    prisma.invoice.findMany({
      include: {
        supplier: { select: { name: true } },
        fund: { select: { name: true, currency: true } },
        po: { select: { poNumber: true } },
      },
      orderBy: { invoiceDate: "desc" },
      take: 100,
    }),
  ]);

  const committedByFund = new Map<string, number>();
  for (const po of orders) {
    if (!COMMITTING.includes(po.status)) continue;
    committedByFund.set(po.fundId, (committedByFund.get(po.fundId) ?? 0) + poTotalCents(po.lines));
  }
  const spentByFund = new Map<string, number>();
  for (const inv of invoices) {
    if (inv.status !== "PAID") continue;
    spentByFund.set(inv.fundId, (spentByFund.get(inv.fundId) ?? 0) + inv.amountCents);
  }

  const fundRows: FundRow[] = funds.map((f) => {
    const committed = committedByFund.get(f.id) ?? 0;
    const spent = spentByFund.get(f.id) ?? 0;
    return {
      id: f.id,
      fiscalYear: f.fiscalYear,
      name: f.name,
      currency: f.currency,
      amountCents: f.amountCents,
      committedCents: committed,
      spentCents: spent,
      availableCents: f.amountCents - committed - spent,
    };
  });

  const openOrdersBySupplier = new Map<string, number>();
  for (const po of orders) {
    if (COMMITTING.includes(po.status))
      openOrdersBySupplier.set(po.supplierId, (openOrdersBySupplier.get(po.supplierId) ?? 0) + 1);
  }

  const rank = (s: string) => (COMMITTING.includes(s) ? 0 : 1);
  const poRows: PoRow[] = orders
    .map((po) => ({
      id: po.id,
      poNumber: po.poNumber,
      supplier: po.supplier.name,
      fund: po.fund.name,
      status: po.status,
      orderedAt: po.orderedAt,
      orderedBy: po.orderedBy,
      notes: po.notes,
      totalCents: poTotalCents(po.lines),
      currency: po.fund.currency,
      lines: po.lines.map((l) => ({
        id: l.id, title: l.title, qty: l.qty, unitCents: l.unitCents, receivedQty: l.receivedQty,
      })),
      invoiced: po.invoices.length > 0,
    }))
    .sort((a, b) => rank(a.status) - rank(b.status) || b.orderedAt.getTime() - a.orderedAt.getTime());

  const invRank = (s: string) => (s === "PENDING" ? 0 : 1);
  const invoiceRows: InvoiceRow[] = invoices
    .map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      supplier: inv.supplier.name,
      fund: inv.fund.name,
      poNumber: inv.po?.poNumber ?? null,
      amountCents: inv.amountCents,
      currency: inv.fund.currency,
      invoiceDate: inv.invoiceDate,
      status: inv.status,
      paidAt: inv.paidAt,
    }))
    .sort((a, b) => invRank(a.status) - invRank(b.status) || b.invoiceDate.getTime() - a.invoiceDate.getTime());

  // Headline totals assume one working currency (SGD by default); mixed
  // currencies are summed per the dominant one and labelled with it.
  const currency = funds[0]?.currency ?? "SGD";
  return {
    funds: fundRows,
    fiscalYears: [...new Set(funds.map((f) => f.fiscalYear))],
    suppliers: suppliers.map((s) => ({
      id: s.id, name: s.name, email: s.email, contact: s.contact, status: s.status,
      openOrders: openOrdersBySupplier.get(s.id) ?? 0,
    })),
    orders: poRows,
    invoices: invoiceRows,
    totals: {
      budgetCents: fundRows.reduce((n, f) => n + f.amountCents, 0),
      committedCents: fundRows.reduce((n, f) => n + f.committedCents, 0),
      spentCents: fundRows.reduce((n, f) => n + f.spentCents, 0),
      pendingInvoiceCents: invoiceRows
        .filter((i) => i.status === "PENDING")
        .reduce((n, i) => n + i.amountCents, 0),
      currency,
    },
  };
}
