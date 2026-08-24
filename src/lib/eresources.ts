// E-resource subscription registry: renewal tracking, usage rollups, and the
// cost-per-use figures that justify (or kill) a renewal.

import { daysBetweenInstants, zonedDayKey, zonedMonthKeyOffset } from "@/lib/tz";
import { prisma } from "@/lib/db";
import { CPU_METRIC } from "@/lib/counter";

export type SubscriptionStatus = "OVERDUE" | "DUE_SOON" | "ACTIVE";

export type SubscriptionRow = {
  id: string;
  provider: string;
  startDate: Date | null;
  renewalDate: Date;
  autoRenews: boolean;
  annualCostCents: number | null;
  currency: string;
  seats: number | null;
  notes: string | null;
  daysLeft: number; // negative = overdue
  status: SubscriptionStatus;
  titles: number; // catalogue records carrying this provider
  usage12: number; // Total_Item_Requests over the trailing 12 months
  monthly: { period: string; count: number }[]; // 12 entries, oldest first
  costPerUse: number | null; // currency units per request; null without cost or usage
};

export type EresourceOverview = {
  subs: SubscriptionRow[]; // most urgent renewal first
  periods: string[]; // the trailing 12 "YYYY-MM" periods, oldest first
  /** Catalogue providers with no subscription record yet. */
  unregistered: { provider: string; titles: number }[];
  /** Annual spend per currency, e.g. [["SGD", 1240000]]. */
  spendByCurrency: [string, number][];
  dueSoon: number;
  overdue: number;
};

const DAY_MS = 86_400_000;
export const DUE_SOON_DAYS = 30;

/** The trailing 12 calendar months including the current one, oldest first. */
export function trailingPeriods(now = new Date()): string[] {
  const out: string[] = [];
  for (let i = 11; i >= 0; i--) out.push(zonedMonthKeyOffset(now, -i));
  return out;
}

/**
 * Calendar days from today to a renewal date, in the library's zone.
 *
 * Was elapsed milliseconds divided by a day. Renewal dates are date-only
 * values stored at noon UTC, i.e. 20:00 Singapore, so a subscription that
 * lapsed this morning did not read as overdue until 8pm.
 */
export function daysUntil(date: Date, now = new Date()): number {
  return daysBetweenInstants(now, date);
}

export function statusOf(daysLeft: number): SubscriptionStatus {
  if (daysLeft < 0) return "OVERDUE";
  if (daysLeft <= DUE_SOON_DAYS) return "DUE_SOON";
  return "ACTIVE";
}

export async function getEresourceOverview(now = new Date()): Promise<EresourceOverview> {
  const periods = trailingPeriods(now);
  const periodSet = new Set(periods);

  const [subs, usage, titleGroups] = await Promise.all([
    prisma.subscription.findMany({ orderBy: { renewalDate: "asc" } }),
    prisma.usageStat.findMany({
      where: { metric: CPU_METRIC, period: { gte: periods[0] } },
      select: { provider: true, period: true, count: true },
    }),
    prisma.resource.groupBy({
      by: ["provider"],
      where: { provider: { not: null } },
      _count: { _all: true },
    }),
  ]);

  // provider → period → count (trailing 12 months only)
  const usageByProvider = new Map<string, Map<string, number>>();
  for (const u of usage) {
    if (!periodSet.has(u.period)) continue;
    const inner = usageByProvider.get(u.provider) ?? new Map<string, number>();
    inner.set(u.period, (inner.get(u.period) ?? 0) + u.count);
    usageByProvider.set(u.provider, inner);
  }

  const titlesByProvider = new Map<string, number>();
  for (const g of titleGroups) {
    if (g.provider) titlesByProvider.set(g.provider, g._count._all);
  }

  const rows: SubscriptionRow[] = subs.map((s) => {
    const perPeriod = usageByProvider.get(s.provider);
    const monthly = periods.map((p) => ({ period: p, count: perPeriod?.get(p) ?? 0 }));
    const usage12 = monthly.reduce((sum, m) => sum + m.count, 0);
    const daysLeft = daysUntil(s.renewalDate, now);
    return {
      id: s.id,
      provider: s.provider,
      startDate: s.startDate,
      renewalDate: s.renewalDate,
      autoRenews: s.autoRenews,
      annualCostCents: s.annualCostCents,
      currency: s.currency,
      seats: s.seats,
      notes: s.notes,
      daysLeft,
      status: statusOf(daysLeft),
      titles: titlesByProvider.get(s.provider) ?? 0,
      usage12,
      monthly,
      costPerUse:
        s.annualCostCents != null && usage12 > 0 ? s.annualCostCents / 100 / usage12 : null,
    };
  });
  rows.sort((a, b) => a.daysLeft - b.daysLeft);

  const registered = new Set(subs.map((s) => s.provider));
  const unregistered = [...titlesByProvider.entries()]
    .filter(([provider]) => !registered.has(provider))
    .map(([provider, titles]) => ({ provider, titles }))
    .sort((a, b) => b.titles - a.titles);

  const spend = new Map<string, number>();
  for (const s of subs) {
    if (s.annualCostCents != null)
      spend.set(s.currency, (spend.get(s.currency) ?? 0) + s.annualCostCents);
  }

  return {
    subs: rows,
    periods,
    unregistered,
    spendByCurrency: [...spend.entries()].sort((a, b) => b[1] - a[1]),
    dueSoon: rows.filter((r) => r.status === "DUE_SOON").length,
    overdue: rows.filter((r) => r.status === "OVERDUE").length,
  };
}

// ---------- Renewal alerts (piggybacks the nightly link-check cron) ----------

// Cadence: alerts start DUE_SOON_DAYS out and repeat every REALERT_DAYS until
// the renewal date is moved or the subscription is removed — roughly day −30,
// day −10, then post-due reminders. The dedup key is the fixed subject line.
const REALERT_DAYS = 20;

export type RenewalAlertResult = { checked: number; due: number; queued: number };

export async function checkRenewalAlerts(now = new Date()): Promise<RenewalAlertResult> {
  const subs = await prisma.subscription.findMany();
  const due = subs.filter((s) => daysUntil(s.renewalDate, now) <= DUE_SOON_DAYS);
  if (due.length === 0) return { checked: subs.length, due: 0, queued: 0 };

  const lookback = new Date(now.getTime() - REALERT_DAYS * DAY_MS);
  const admins = await prisma.adminUser.findMany({
    where: { status: "ACTIVE" },
    select: { name: true, email: true },
  });

  let queued = 0;
  for (const s of due) {
    const subject = `Renewal alert — ${s.provider}`;
    const already = await prisma.mailQueue.findFirst({
      where: { template: "RENEWAL_ALERT", subject, createdAt: { gt: lookback } },
      select: { id: true },
    });
    if (already) continue;

    const daysLeft = daysUntil(s.renewalDate, now);
    const when = zonedDayKey(s.renewalDate);
    const timing =
      daysLeft < 0
        ? `passed ${-daysLeft} day${daysLeft === -1 ? "" : "s"} ago (${when})`
        : `is due in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (${when})`;
    const cost =
      s.annualCostCents != null
        ? `Annual cost on record: ${s.currency} ${(s.annualCostCents / 100).toLocaleString("en-SG")}.`
        : "No annual cost on record.";
    const auto = s.autoRenews
      ? "This subscription AUTO-RENEWS — act before the date if you intend to cancel or renegotiate."
      : "This subscription does not auto-renew — access lapses unless it is renewed.";
    const body = `The ${s.provider} subscription renewal ${timing}.\n\n${auto}\n${cost}${s.seats != null ? `\nLicensed seats: ${s.seats}.` : ""}\n\nReview usage and cost-per-use on the Subscriptions page before deciding.`;

    if (admins.length > 0) {
      await prisma.mailQueue.createMany({
        data: admins.map((a) => ({
          toEmail: a.email,
          toName: a.name,
          subject,
          body,
          template: "RENEWAL_ALERT",
        })),
      });
      queued += admins.length;
    }
  }
  return { checked: subs.length, due: due.length, queued };
}
