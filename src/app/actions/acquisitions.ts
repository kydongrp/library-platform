"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit } from "@/lib/audit";
import { nextPoNumber, poTotalCents } from "@/lib/acquisitions";

// Ordering is catalogue work (CATALOGUE edit); PAYING an invoice is a
// finance approval and is held at Administrator level (ADMIN edit).
async function requireAcqEditor(): Promise<{ name: string } | null> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "CATALOGUE")) return null;
  return { name: admin!.name };
}
async function requireFinanceAdmin(): Promise<{ name: string } | null> {
  const admin = await getCurrentAdmin();
  if (!canEdit(admin, "ADMIN")) return null;
  return { name: admin!.name };
}

const NO_PERMISSION = { ok: false as const, message: "You don't have permission to manage acquisitions." };
const clip = (v: FormDataEntryValue | null, n: number) => String(v ?? "").trim().slice(0, n);
const PO_LINE_SLOTS = 5;

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

/** "1,234.50" → cents; null for blank; undefined for garbage. */
function parseMoneyCents(raw: string): number | null | undefined {
  const v = raw.replace(/[sS]?\$|,|\s/g, "");
  if (v === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return undefined;
  const cents = Math.round(parseFloat(v) * 100);
  return cents >= 0 && cents <= 50_000_000_000 ? cents : undefined; // ≤ $500M
}

function parseDateOnly(raw: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ---------- Suppliers ---------- */

export async function createSupplier(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAcqEditor();
  if (!admin) return NO_PERMISSION;

  const name = clip(formData.get("name"), 120);
  if (!name) return { ok: false, message: "Supplier name is required." };
  const email = clip(formData.get("email"), 200) || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return { ok: false, message: "Supplier email doesn't look like an email address." };

  try {
    const s = await prisma.supplier.create({
      data: { name, email, contact: clip(formData.get("contact"), 200) || null, notes: clip(formData.get("notes"), 1000) || null },
    });
    await audit({ action: "acq.supplier.create", summary: `Added supplier "${name}"`, entity: "Supplier", entityId: s.id });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, message: `Supplier "${name}" already exists.` };
    throw e;
  }
  revalidatePath("/admin/acquisitions");
  return { ok: true, message: `Supplier "${name}" added.` };
}

export async function toggleSupplier(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAcqEditor();
  if (!admin) return NO_PERMISSION;

  const id = clip(formData.get("id"), 40);
  const s = await prisma.supplier.findUnique({ where: { id } });
  if (!s) return { ok: false, message: "That supplier no longer exists." };
  const status = s.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
  await prisma.supplier.update({ where: { id }, data: { status } });
  await audit({
    action: "acq.supplier.toggle",
    summary: `${status === "ACTIVE" ? "Reactivated" : "Deactivated"} supplier "${s.name}"`,
    entity: "Supplier",
    entityId: id,
  });
  revalidatePath("/admin/acquisitions");
  return { ok: true, message: `"${s.name}" is now ${status.toLowerCase()}.` };
}

/* ---------- Funds ---------- */

export async function createFund(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAcqEditor();
  if (!admin) return NO_PERMISSION;

  const fiscalYear = clip(formData.get("fiscalYear"), 10);
  if (!/^FY\d{4}$/.test(fiscalYear))
    return { ok: false, message: "Fiscal year must look like FY2026." };
  const name = clip(formData.get("name"), 80);
  if (!name) return { ok: false, message: "Fund name is required." };
  const amount = parseMoneyCents(clip(formData.get("amount"), 20));
  if (amount == null || amount === 0)
    return { ok: false, message: "Set the fund's budget amount (e.g. 50000)." };
  const currency = clip(formData.get("currency"), 3).toUpperCase() || "SGD";
  if (!/^[A-Z]{3}$/.test(currency))
    return { ok: false, message: "Currency must be a 3-letter code." };

  try {
    const f = await prisma.acqFund.create({ data: { fiscalYear, name, amountCents: amount, currency } });
    await audit({
      action: "acq.fund.create",
      summary: `Created fund "${name}" (${fiscalYear}, ${currency} ${(amount / 100).toLocaleString("en-SG")})`,
      entity: "AcqFund",
      entityId: f.id,
    });
  } catch (e) {
    if (isUniqueViolation(e))
      return { ok: false, message: `Fund "${name}" already exists for ${fiscalYear}.` };
    throw e;
  }
  revalidatePath("/admin/acquisitions");
  return { ok: true, message: `Fund "${name}" created for ${fiscalYear}.` };
}

/* ---------- Purchase orders ---------- */

export async function createPurchaseOrder(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAcqEditor();
  if (!admin) return NO_PERMISSION;

  const supplierId = clip(formData.get("supplierId"), 40);
  const fundId = clip(formData.get("fundId"), 40);
  if (!supplierId || !fundId)
    return { ok: false, message: "Choose a supplier and a fund." };

  const lines: { title: string; qty: number; unitCents: number }[] = [];
  for (let i = 1; i <= PO_LINE_SLOTS; i++) {
    const title = clip(formData.get(`line${i}Title`), 300);
    const qtyRaw = clip(formData.get(`line${i}Qty`), 6);
    const unitRaw = clip(formData.get(`line${i}Unit`), 20);
    if (!title && !qtyRaw && !unitRaw) continue;
    if (!title) return { ok: false, message: `Line ${i} needs a title.` };
    const qty = qtyRaw ? parseInt(qtyRaw, 10) : 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > 10_000)
      return { ok: false, message: `Line ${i}: quantity must be a whole number.` };
    const unitCents = parseMoneyCents(unitRaw);
    if (unitCents == null)
      return { ok: false, message: `Line ${i}: set a unit price (e.g. 129.90).` };
    lines.push({ title, qty, unitCents });
  }
  if (lines.length === 0)
    return { ok: false, message: "Add at least one order line." };

  const [supplier, fund] = await Promise.all([
    prisma.supplier.findUnique({ where: { id: supplierId }, select: { name: true, status: true } }),
    prisma.acqFund.findUnique({ where: { id: fundId }, select: { name: true, currency: true } }),
  ]);
  if (!supplier) return { ok: false, message: "That supplier no longer exists." };
  if (supplier.status !== "ACTIVE")
    return { ok: false, message: `"${supplier.name}" is inactive — reactivate it before ordering.` };
  if (!fund) return { ok: false, message: "That fund no longer exists." };

  const notes = clip(formData.get("notes"), 1000) || null;
  const total = poTotalCents(lines);

  // PO number generation races concurrent submits — the unique index decides,
  // so retry with a fresh number a couple of times.
  for (let attempt = 0; attempt < 3; attempt++) {
    const poNumber = await nextPoNumber();
    try {
      const po = await prisma.purchaseOrder.create({
        data: { poNumber, supplierId, fundId, orderedBy: admin.name, notes, lines: { create: lines } },
      });
      await audit({
        action: "acq.po.create",
        summary: `Raised ${poNumber} to ${supplier.name}: ${lines.length} line${lines.length === 1 ? "" : "s"}, ${fund.currency} ${(total / 100).toLocaleString("en-SG")} from "${fund.name}"`,
        entity: "PurchaseOrder",
        entityId: po.id,
      });
      revalidatePath("/admin/acquisitions");
      return { ok: true, message: `${poNumber} raised — ${fund.currency} ${(total / 100).toLocaleString("en-SG")} committed from "${fund.name}".` };
    } catch (e) {
      if (isUniqueViolation(e)) continue;
      throw e;
    }
  }
  return { ok: false, message: "Could not allocate a PO number — try again." };
}

export async function receivePoLine(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAcqEditor();
  if (!admin) return NO_PERMISSION;

  const lineId = clip(formData.get("lineId"), 40);
  const line = await prisma.poLine.findUnique({
    where: { id: lineId },
    include: { po: { include: { lines: true } } },
  });
  if (!line) return { ok: false, message: "That order line no longer exists." };
  if (!["ORDERED", "RECEIVED"].includes(line.po.status))
    return { ok: false, message: `${line.po.poNumber} is ${line.po.status.toLowerCase()} — nothing to receive.` };
  if (line.receivedQty >= line.qty)
    return { ok: false, message: "That line is already fully received." };

  await prisma.poLine.update({ where: { id: lineId }, data: { receivedQty: line.qty } });
  const allReceived = line.po.lines.every((l) => (l.id === lineId ? true : l.receivedQty >= l.qty));
  if (allReceived && line.po.status === "ORDERED") {
    await prisma.purchaseOrder.update({ where: { id: line.poId }, data: { status: "RECEIVED" } });
  }
  await audit({
    action: "acq.po.receive",
    summary: `Received "${line.title}" ×${line.qty} on ${line.po.poNumber}${allReceived ? " — order fully received" : ""}`,
    entity: "PurchaseOrder",
    entityId: line.poId,
  });
  revalidatePath("/admin/acquisitions");
  return { ok: true, message: allReceived ? `${line.po.poNumber} fully received.` : `"${line.title}" received.` };
}

export async function cancelPurchaseOrder(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAcqEditor();
  if (!admin) return NO_PERMISSION;

  const id = clip(formData.get("id"), 40);
  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: { invoices: { select: { id: true } } },
  });
  if (!po) return { ok: false, message: "That order no longer exists." };
  if (po.status !== "ORDERED")
    return { ok: false, message: `Only ordered POs can be cancelled — ${po.poNumber} is ${po.status.toLowerCase()}.` };
  if (po.invoices.length > 0)
    return { ok: false, message: `${po.poNumber} already has an invoice against it — settle that instead.` };

  await prisma.purchaseOrder.update({ where: { id }, data: { status: "CANCELLED" } });
  await audit({
    action: "acq.po.cancel",
    summary: `Cancelled ${po.poNumber} (commitment released)`,
    entity: "PurchaseOrder",
    entityId: id,
  });
  revalidatePath("/admin/acquisitions");
  return { ok: true, message: `${po.poNumber} cancelled — its commitment is released.` };
}

/* ---------- Invoices ---------- */

export async function recordInvoice(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAcqEditor();
  if (!admin) return NO_PERMISSION;

  const supplierId = clip(formData.get("supplierId"), 40);
  const fundId = clip(formData.get("fundId"), 40);
  const poId = clip(formData.get("poId"), 40) || null;
  const invoiceNumber = clip(formData.get("invoiceNumber"), 60);
  if (!supplierId || !fundId) return { ok: false, message: "Choose a supplier and a fund." };
  if (!invoiceNumber) return { ok: false, message: "The supplier's invoice number is required." };
  const amount = parseMoneyCents(clip(formData.get("amount"), 20));
  if (amount == null || amount === 0) return { ok: false, message: "Set the invoice amount." };
  const invoiceDate = parseDateOnly(clip(formData.get("invoiceDate"), 10));
  if (!invoiceDate) return { ok: false, message: "Set the invoice date." };

  const [supplier, fund, po] = await Promise.all([
    prisma.supplier.findUnique({ where: { id: supplierId }, select: { name: true } }),
    prisma.acqFund.findUnique({ where: { id: fundId }, select: { name: true, currency: true } }),
    poId ? prisma.purchaseOrder.findUnique({ where: { id: poId }, select: { poNumber: true, supplierId: true } }) : null,
  ]);
  if (!supplier || !fund) return { ok: false, message: "Supplier or fund no longer exists." };
  if (poId && !po) return { ok: false, message: "That purchase order no longer exists." };
  if (po && po.supplierId !== supplierId)
    return { ok: false, message: `${po.poNumber} belongs to a different supplier.` };

  try {
    const inv = await prisma.invoice.create({
      data: { invoiceNumber, supplierId, fundId, poId, amountCents: amount, invoiceDate, notes: clip(formData.get("notes"), 1000) || null },
    });
    await audit({
      action: "acq.invoice.record",
      summary: `Recorded invoice ${invoiceNumber} from ${supplier.name}: ${fund.currency} ${(amount / 100).toLocaleString("en-SG")} against "${fund.name}"${po ? ` (${po.poNumber})` : ""}`,
      entity: "Invoice",
      entityId: inv.id,
    });
  } catch (e) {
    if (isUniqueViolation(e))
      return { ok: false, message: `Invoice ${invoiceNumber} from ${supplier.name} is already recorded.` };
    throw e;
  }
  revalidatePath("/admin/acquisitions");
  return { ok: true, message: `Invoice ${invoiceNumber} recorded — awaiting payment approval.` };
}

export async function markInvoicePaid(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireFinanceAdmin();
  if (!admin)
    return { ok: false, message: "Approving payment needs Administrator rights." };

  const id = clip(formData.get("id"), 40);
  const r = await prisma.invoice.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "PAID", paidAt: new Date() },
  });
  if (r.count === 0) return { ok: false, message: "That invoice is gone or already paid." };

  const inv = await prisma.invoice.findUnique({
    where: { id },
    include: {
      supplier: { select: { name: true } },
      po: { include: { lines: true } },
    },
  });
  // Fully received + paid → the PO closes and stops committing (the paid
  // invoice now carries the cost).
  let closed = false;
  if (inv?.po && inv.po.status === "RECEIVED" && inv.po.lines.every((l) => l.receivedQty >= l.qty)) {
    await prisma.purchaseOrder.update({ where: { id: inv.po.id }, data: { status: "CLOSED" } });
    closed = true;
  }
  await audit({
    action: "acq.invoice.pay",
    summary: `Paid invoice ${inv?.invoiceNumber ?? id} (${inv?.supplier.name ?? "?"})${closed ? ` — ${inv?.po?.poNumber} closed` : ""}`,
    entity: "Invoice",
    entityId: id,
  });
  revalidatePath("/admin/acquisitions");
  return { ok: true, message: `Invoice paid.${closed ? ` ${inv?.po?.poNumber} closed.` : ""}` };
}
