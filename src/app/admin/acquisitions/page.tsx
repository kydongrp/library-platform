import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { Card, Badge, EmptyState } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import {
  receivePoLine,
  cancelPurchaseOrder,
  markInvoicePaid,
  toggleSupplier,
  toggleAccount,
  deleteAccount,
} from "@/app/actions/acquisitions";
import { prisma } from "@/lib/db";
import { getAcquisitionsOverview, type FundRow } from "@/lib/acquisitions";
import { formatDate } from "@/lib/format";
import { SupplierForm, FundForm, PurchaseOrderForm, InvoiceForm, AccountForm } from "./widgets";

export const dynamic = "force-dynamic";

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-SG", {
      style: "currency", currency, maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toLocaleString("en-SG")}`;
  }
}

const PO_TONE: Record<string, { label: string; icon: string; pill: string }> = {
  ORDERED: { label: "Ordered", icon: "◷", pill: "bg-blue-50 text-blue-800 ring-blue-200" },
  RECEIVED: { label: "Received", icon: "✓", pill: "bg-green-50 text-green-800 ring-green-200" },
  CLOSED: { label: "Closed", icon: "■", pill: "bg-stone-100 text-stone-600 ring-stone-200" },
  CANCELLED: { label: "Cancelled", icon: "✕", pill: "bg-red-50 text-red-700 ring-red-200" },
};

/** Stacked spend meter: dark = spent, light = committed, track = remaining. */
function FundMeter({ f }: { f: FundRow }) {
  const spentPct = Math.min(100, (f.spentCents / f.amountCents) * 100);
  const committedPct = Math.min(100 - spentPct, (f.committedCents / f.amountCents) * 100);
  const over = f.availableCents < 0;
  return (
    <div>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-stone-200"
        role="img"
        aria-label={`${f.name}: ${Math.round(spentPct)}% spent, ${Math.round(committedPct)}% committed`}
      >
        <div style={{ width: `${spentPct}%`, background: "#0d9488" }} />
        <div style={{ width: `${committedPct}%`, background: "#99f6e4" }} />
      </div>
      <p className={`mt-1 text-xs ${over ? "font-semibold text-red-700" : "text-muted-foreground"}`} style={{ fontVariantNumeric: "tabular-nums" }}>
        {money(f.spentCents, f.currency)} spent · {money(f.committedCents, f.currency)} committed ·{" "}
        {over ? `${money(-f.availableCents, f.currency)} OVER budget` : `${money(f.availableCents, f.currency)} available`}
      </p>
    </div>
  );
}

export default async function AcquisitionsPage() {
  const admin = await requireAdminView("CATALOGUE");
  const editable = canEdit(admin, "CATALOGUE");
  const finance = canEdit(admin, "ADMIN");

  const o = await getAcquisitionsOverview();
  // Row 60: accounts are a separate axis from funds. A fund is the budget,
  // an account is the finance code the spend is booked against.
  const accounts = await prisma.acqAccount.findMany({
    orderBy: [{ status: "asc" }, { code: "asc" }],
    include: { _count: { select: { orders: true, invoices: true } } },
  });
  const activeAccounts = accounts.filter((a) => a.status === "ACTIVE").map(({ id, code, name }) => ({ id, code, name }));

  const activeSuppliers = o.suppliers.filter((s) => s.status === "ACTIVE").map(({ id, name }) => ({ id, name }));
  const fundOptions = o.funds.map((f) => ({ id: f.id, name: `${f.name} (${f.fiscalYear})` }));
  const openOrders = o.orders
    .filter((po) => ["ORDERED", "RECEIVED"].includes(po.status))
    .map((po) => ({ id: po.id, label: `${po.poNumber} · ${po.supplier} · ${money(po.totalCents, po.currency)}` }));

  const tiles = [
    { label: "Budget", value: money(o.totals.budgetCents, o.totals.currency), alert: false },
    { label: "Committed (open POs)", value: money(o.totals.committedCents, o.totals.currency), alert: false },
    { label: "Spent (paid invoices)", value: money(o.totals.spentCents, o.totals.currency), alert: false },
    { label: "Invoices awaiting payment", value: money(o.totals.pendingInvoiceCents, o.totals.currency), alert: o.totals.pendingInvoiceCents > 0 },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Acquisitions</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Budgets, suppliers, purchase orders and invoices. Raising a PO
          (Purchase Order) commits money from its fund; receiving marks goods
          arrived; paying the invoice (an Administrator approval) moves the
          cost from committed to spent and closes the order.
        </p>
      </div>

      {/* Totals */}
      <dl className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">{t.label}</dt>
            <dd className={`mt-1 font-display text-xl font-semibold ${t.alert ? "text-amber-700" : ""}`} style={{ fontVariantNumeric: "tabular-nums" }}>
              {t.value}
            </dd>
          </div>
        ))}
      </dl>

      {/* Funds */}
      <Card className="mb-6 p-5">
        <h2 className="mb-1 font-display text-lg font-semibold">Funds</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Dark = spent (paid invoices) · light = committed (open orders) · track = available.
        </p>
        {o.funds.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">No funds yet. Create the year&apos;s budget lines below.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {o.funds.map((f) => (
              <div key={f.id} className="rounded-lg border border-border p-3">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">{f.name}</p>
                  <span className="text-xs text-muted-foreground">
                    {f.fiscalYear} · {money(f.amountCents, f.currency)}
                  </span>
                </div>
                <FundMeter f={f} />
              </div>
            ))}
          </div>
        )}
        {editable && (
          <div className="mt-4 border-t border-border pt-4">
            <FundForm />
          </div>
        )}
      </Card>

      {/* Purchase orders */}
      <Card className="mb-6 p-5">
        <h2 className="mb-3 font-display text-lg font-semibold">Purchase orders</h2>
        {o.orders.length === 0 ? (
          <EmptyState title="No purchase orders" description="Raise one below. It commits money from its fund until invoiced and paid." />
        ) : (
          <div className="space-y-3">
            {o.orders.map((po) => (
              <div key={po.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold">{po.poNumber}</span>
                    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${PO_TONE[po.status].pill}`}>
                      {PO_TONE[po.status].icon} {PO_TONE[po.status].label}
                    </span>
                    <Badge tone="neutral">{po.supplier}</Badge>
                    <Badge tone="muted">{po.fund}</Badge>
                    {po.invoiced && <Badge tone="muted">invoiced</Badge>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {money(po.totalCents, po.currency)}
                    </span>
                    {editable && po.status === "ORDERED" && !po.invoiced && (
                      <ActionButton action={cancelPurchaseOrder} fields={{ id: po.id }} variant="ghost"
                        className="!px-2 !py-1 text-xs text-red-700" pendingLabel="…"
                        confirm={`Cancel ${po.poNumber}? Its commitment is released.`}>
                        Cancel
                      </ActionButton>
                    )}
                  </div>
                </div>
                <ul className="mt-2 divide-y divide-border">
                  {po.lines.map((l) => (
                    <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                      <span className="min-w-0 truncate text-sm">
                        {l.title}{" "}
                        <span className="text-xs text-muted-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
                          ×{l.qty} @ {money(l.unitCents, po.currency)}
                        </span>
                      </span>
                      {l.receivedQty >= l.qty ? (
                        <Badge tone="success">✓ received</Badge>
                      ) : editable && ["ORDERED", "RECEIVED"].includes(po.status) ? (
                        <ActionButton action={receivePoLine} fields={{ lineId: l.id }}
                          className="!px-2 !py-1 text-xs" pendingLabel="…">
                          ✓ Receive
                        </ActionButton>
                      ) : (
                        <Badge tone="muted">awaiting</Badge>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-muted-foreground">
                  Raised {formatDate(po.orderedAt)} by {po.orderedBy}{po.notes ? ` · ${po.notes}` : ""}
                </p>
              </div>
            ))}
          </div>
        )}
        {editable && (
          <div className="mt-4 border-t border-border pt-4">
            <PurchaseOrderForm suppliers={activeSuppliers} funds={fundOptions} accounts={activeAccounts} />
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Invoices */}
        <Card className="p-5">
          <h2 className="mb-3 font-display text-lg font-semibold">Invoices</h2>
          {o.invoices.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">No invoices recorded.</p>
          ) : (
            <ul className="divide-y divide-border">
              {o.invoices.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {inv.invoiceNumber} · {inv.supplier}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {inv.fund}{inv.poNumber ? ` · ${inv.poNumber}` : ""} · {formatDate(inv.invoiceDate)}
                      {inv.paidAt ? ` · paid ${formatDate(inv.paidAt)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {money(inv.amountCents, inv.currency)}
                    </span>
                    {inv.status === "PAID" ? (
                      <Badge tone="success">✓ Paid</Badge>
                    ) : finance ? (
                      <ActionButton action={markInvoicePaid} fields={{ id: inv.id }}
                        className="!px-2 !py-1 text-xs" pendingLabel="…"
                        confirm={`Approve payment of ${inv.invoiceNumber} (${money(inv.amountCents, inv.currency)})?`}>
                        Approve payment
                      </ActionButton>
                    ) : (
                      <Badge tone="accent">awaiting approval</Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {editable && (
            <div className="mt-4 border-t border-border pt-4">
              <InvoiceForm suppliers={activeSuppliers} funds={fundOptions} openOrders={openOrders} accounts={activeAccounts} />
            </div>
          )}
        </Card>

        {/* Accounts (row 60) */}
        <Card className="p-5">
          <h2 className="mb-1 font-display text-lg font-semibold">Accounts</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            The finance codes spend is booked against. A fund is the budget; an
            account is what finance reconciles on, so one fund can be charged to
            several accounts and vice versa.
          </p>
          {accounts.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              No accounts yet. Orders and invoices simply carry no code until one exists.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {accounts.map((a) => {
                const used = a._count.orders + a._count.invoices;
                return (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        <span className="font-mono text-xs">{a.code}</span> · {a.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {used === 0
                          ? "not used yet"
                          : `${a._count.orders} order${a._count.orders === 1 ? "" : "s"} · ${a._count.invoices} invoice${a._count.invoices === 1 ? "" : "s"}`}
                        {a.notes ? ` · ${a.notes}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {a.status === "ACTIVE" ? <Badge tone="success">Active</Badge> : <Badge tone="muted">Closed</Badge>}
                      {editable && (
                        <>
                          <ActionButton action={toggleAccount} fields={{ id: a.id }} variant="ghost"
                            className="!px-2 !py-1 text-xs" pendingLabel="…">
                            {a.status === "ACTIVE" ? "Close" : "Reopen"}
                          </ActionButton>
                          {used === 0 && (
                            <ActionButton action={deleteAccount} fields={{ id: a.id }} variant="ghost"
                              className="!px-2 !py-1 text-xs text-red-700" pendingLabel="…"
                              confirm={`Delete account ${a.code}?`}>
                              Delete
                            </ActionButton>
                          )}
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {editable && (
            <div className="mt-4 border-t border-border pt-4">
              <AccountForm />
            </div>
          )}
        </Card>

        {/* Suppliers */}
        <Card className="p-5">
          <h2 className="mb-3 font-display text-lg font-semibold">Suppliers</h2>
          {o.suppliers.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">No suppliers yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {o.suppliers.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{s.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.email ?? "no email"}{s.contact ? ` · ${s.contact}` : ""}
                      {s.openOrders > 0 ? ` · ${s.openOrders} open order${s.openOrders === 1 ? "" : "s"}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {s.status === "ACTIVE" ? <Badge tone="success">Active</Badge> : <Badge tone="muted">Inactive</Badge>}
                    {editable && (
                      <ActionButton action={toggleSupplier} fields={{ id: s.id }} variant="ghost"
                        className="!px-2 !py-1 text-xs" pendingLabel="…">
                        {s.status === "ACTIVE" ? "Deactivate" : "Reactivate"}
                      </ActionButton>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {editable && (
            <div className="mt-4 border-t border-border pt-4">
              <SupplierForm />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
