"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/types";
import { getCurrentAdmin, canEdit } from "@/lib/admin-session";
import { audit, diffOf } from "@/lib/audit";
import { parseCounterUsage, CPU_METRIC } from "@/lib/counter";

// Server actions are directly invocable endpoints — re-check rights here.
// Subscriptions are content operations, so they ride the CATALOGUE area.
async function canEditEresources(): Promise<boolean> {
  return canEdit(await getCurrentAdmin(), "CATALOGUE");
}

const NO_PERMISSION = { ok: false as const, message: "You don't have permission to manage subscriptions." };
const MAX_UPLOAD_BYTES = 3_500_000; // stay under the 4MB server-action body limit

const clip = (v: FormDataEntryValue | null, max: number) =>
  String(v ?? "").trim().slice(0, max);

/** "12,400.50" / "S$12400" → cents; null for blank; NaN-ish → undefined (error). */
function parseMoneyCents(raw: string): number | null | undefined {
  const v = raw.replace(/[sS]?\$|,|\s/g, "");
  if (v === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return undefined;
  const cents = Math.round(parseFloat(v) * 100);
  return cents >= 0 && cents <= 5_000_000_000 ? cents : undefined; // ≤ $50M
}

function parseDateOnly(raw: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T12:00:00Z`); // noon UTC dodges timezone date-shifts
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function saveSubscription(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditEresources())) return NO_PERMISSION;

  const id = clip(formData.get("id"), 40);
  const provider = clip(formData.get("provider"), 80);
  if (!provider) return { ok: false, message: "Provider is required." };

  const renewalRaw = clip(formData.get("renewalDate"), 10);
  const renewalDate = parseDateOnly(renewalRaw);
  if (!renewalDate) return { ok: false, message: "A renewal date (YYYY-MM-DD) is required." };

  const startRaw = clip(formData.get("startDate"), 10);
  const startDate = startRaw ? parseDateOnly(startRaw) : null;
  if (startRaw && !startDate) return { ok: false, message: "Start date is not a valid date." };

  const costCents = parseMoneyCents(clip(formData.get("annualCost"), 20));
  if (costCents === undefined)
    return { ok: false, message: "Annual cost must be a plain amount like 12400 or 12400.50." };

  const currency = clip(formData.get("currency"), 3).toUpperCase() || "SGD";
  if (!/^[A-Z]{3}$/.test(currency))
    return { ok: false, message: "Currency must be a 3-letter code (SGD, USD…)." };

  const seatsRaw = clip(formData.get("seats"), 8);
  const seats = seatsRaw ? parseInt(seatsRaw, 10) : null;
  if (seatsRaw && (!Number.isInteger(seats) || seats! < 0 || seats! > 1_000_000))
    return { ok: false, message: "Seats must be a whole number." };

  const data = {
    provider,
    renewalDate,
    startDate,
    autoRenews: formData.get("autoRenews") === "on",
    annualCostCents: costCents,
    currency,
    seats,
    notes: clip(formData.get("notes"), 2000) || null,
  };

  // Provider is the natural key — block renames/creates that collide.
  const clash = await prisma.subscription.findFirst({
    where: { provider, ...(id ? { NOT: { id } } : {}) },
    select: { id: true },
  });
  if (clash)
    return { ok: false, message: `A subscription for ${provider} already exists — edit that one instead.` };

  try {
    if (id) {
      const before = await prisma.subscription.findUnique({ where: { id } });
      if (!before) return { ok: false, message: "That subscription no longer exists." };
      await prisma.subscription.update({ where: { id }, data });
      await audit({
        action: "eresources.subscription.update",
        summary: `Updated ${provider} subscription (renewal ${renewalRaw})`,
        entity: "Subscription",
        entityId: id,
        detail: diffOf(before, { ...before, ...data }),
      });
    } else {
      const created = await prisma.subscription.create({ data });
      await audit({
        action: "eresources.subscription.create",
        summary: `Registered ${provider} subscription (renewal ${renewalRaw})`,
        entity: "Subscription",
        entityId: created.id,
      });
    }
  } catch (err) {
    // The pre-check above races concurrent submits — the unique index is the
    // real guard, so translate its violation instead of surfacing a 500.
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "P2002")
      return { ok: false, message: `A subscription for ${provider} already exists — edit that one instead.` };
    throw err;
  }
  revalidatePath("/admin/eresources");
  return { ok: true, message: id ? "Subscription updated." : "Subscription registered." };
}

export async function deleteSubscription(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditEresources())) return NO_PERMISSION;
  const id = clip(formData.get("id"), 40);
  if (!id) return { ok: false, message: "Missing subscription id." };

  const sub = await prisma.subscription.findUnique({ where: { id } });
  if (!sub) return { ok: false, message: "That subscription no longer exists." };

  await prisma.subscription.delete({ where: { id } });
  await audit({
    action: "eresources.subscription.delete",
    summary: `Removed ${sub.provider} subscription (usage history retained)`,
    entity: "Subscription",
    entityId: id,
    detail: { removed: { provider: sub.provider, renewalDate: sub.renewalDate, annualCostCents: sub.annualCostCents } },
  });
  revalidatePath("/admin/eresources");
  return { ok: true, message: `Removed the ${sub.provider} subscription. Usage history was kept.` };
}

export async function ingestCounterUsage(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditEresources())) return NO_PERMISSION;

  const provider = clip(formData.get("provider"), 80);
  if (!provider) return { ok: false, message: "Choose which provider this report belongs to." };

  const file = formData.get("file");
  let text = "";
  let source = "pasted";
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_UPLOAD_BYTES)
      return { ok: false, message: "That file is over 3.5MB. COUNTER monthly reports are small — export a single year at a time." };
    text = await file.text();
    source = file.name.slice(0, 120) || "upload";
  } else {
    text = String(formData.get("pasted") ?? "");
    if (text.length > MAX_UPLOAD_BYTES)
      return { ok: false, message: "Pasted content is too large — paste one report at a time." };
  }
  if (!text.trim()) return { ok: false, message: "Upload a COUNTER CSV/TSV file or paste its contents." };

  const result = parseCounterUsage(text);
  if (result.months.length === 0) {
    return { ok: false, message: result.warnings[0] ?? "No monthly usage figures found in that file." };
  }

  for (const m of result.months) {
    await prisma.usageStat.upsert({
      where: { provider_period_metric: { provider, period: m.period, metric: m.metric } },
      create: { provider, period: m.period, metric: m.metric, count: m.count, source },
      update: { count: m.count, source },
    });
  }

  const periods = [...new Set(result.months.map((m) => m.period))].sort();
  const metrics = [...new Set(result.months.map((m) => m.metric))];
  const cpuTotal = result.months.filter((m) => m.metric === CPU_METRIC).reduce((s, m) => s + m.count, 0);
  await audit({
    action: "eresources.usage.ingest",
    summary: `Ingested ${provider} usage: ${periods.length} month${periods.length === 1 ? "" : "s"} (${periods[0]} – ${periods[periods.length - 1]}), ${cpuTotal.toLocaleString()} item requests, from ${source}`,
    entity: "UsageStat",
    detail: { provider, source, reportName: result.reportName, platform: result.platform, metrics, warnings: result.warnings },
  });

  const notes: string[] = [];
  if (result.platform && result.platform.toLowerCase() !== provider.toLowerCase())
    notes.push(`Note: the report names its platform as "${result.platform}" — check you picked the right provider.`);
  notes.push(...result.warnings);
  revalidatePath("/admin/eresources");
  return {
    ok: true,
    message: `Imported ${periods.length} month${periods.length === 1 ? "" : "s"} of ${provider} usage (${periods[0]} – ${periods[periods.length - 1]}).${notes.length ? ` ${notes.join(" ")}` : ""}`,
  };
}

export async function addUsageMonth(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await canEditEresources())) return NO_PERMISSION;

  const provider = clip(formData.get("provider"), 80);
  if (!provider) return { ok: false, message: "Choose a provider." };
  const period = clip(formData.get("period"), 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
    return { ok: false, message: "Month must look like 2026-08." };
  const countRaw = clip(formData.get("count"), 12);
  const count = parseInt(countRaw, 10);
  if (!Number.isInteger(count) || count < 0 || count > 1_000_000_000)
    return { ok: false, message: "Uses must be a whole number." };

  await prisma.usageStat.upsert({
    where: { provider_period_metric: { provider, period, metric: CPU_METRIC } },
    create: { provider, period, metric: CPU_METRIC, count, source: "manual" },
    update: { count, source: "manual" },
  });
  await audit({
    action: "eresources.usage.manual",
    summary: `Set ${provider} usage for ${period} to ${count.toLocaleString()} item requests (manual entry)`,
    entity: "UsageStat",
  });
  revalidatePath("/admin/eresources");
  return { ok: true, message: `${provider} · ${period} set to ${count.toLocaleString()} uses.` };
}
