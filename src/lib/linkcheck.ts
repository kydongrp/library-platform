// Access health (roadmap #4): scan every digital access URL, roll results up
// per provider, and alert when a provider looks down across the board. This is
// the admin-side answer to "the link worked yesterday". Server-only. Callers
// own authorisation (admin action or CRON_SECRET route) and auditing.
import { prisma } from "@/lib/db";
import { isBlockedHost } from "@/lib/net";
import { linkState, type LinkState } from "@/lib/link-state";

const LINK_TIMEOUT_MS = 5_000;
const SCAN_CONCURRENCY = 6;

// Provider status thresholds: DOWN needs a real cluster of failures, not one
// flaky article; any failure at all is worth a librarian's glance.
const DOWN_MIN_BROKEN = 3;
const DOWN_RATIO = 0.5;

export type ProviderHealth = {
  provider: string; // display name; "Local collection" when unset
  checked: number;
  broken: number;
  /**
   * Answered, but did not serve the page: a subscription wall or a bot gate.
   * Counted apart from broken because it is not a fault, and apart from the
   * healthy remainder because the scan did not actually see the document.
   */
  unverified: number;
  okRatio: number; // 0..1, confirmed retrievals only
  status: "HEALTHY" | "DEGRADED" | "DOWN";
  sampleError: string | null; // most common error among the broken links
};

export type AccessHealth = {
  lastScanAt: Date | null;
  lastScanBy: string | null;
  totalChecked: number;
  totalBroken: number;
  /** Answered without handing over the page. Neither a pass nor a failure. */
  totalUnverified: number;
  providers: ProviderHealth[];
  broken: {
    resourceId: string;
    title: string;
    provider: string;
    url: string;
    error: string;
    checkedAt: Date;
  }[];
};

async function checkUrl(
  url: string,
): Promise<{ ok: boolean; statusCode: number | null; error: string | null }> {
  if (isBlockedHost(url))
    return { ok: false, statusCode: null, error: "Blocked host (private/loopback)" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);
  try {
    // GET, not HEAD: several providers (incl. IEEE) reject HEAD requests.
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "AthenaeumLinkCheck/1.0" },
    });
    // Auth walls (401/403) mean the link resolves but needs the subscription;
    // that's not "broken" for an externally licensed resource.
    const ok = res.status < 500 && res.status !== 404 && res.status !== 410;
    return { ok, statusCode: res.status, error: ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    const msg =
      e instanceof Error ? (e.name === "AbortError" ? "Timed out" : e.message) : "Fetch failed";
    return { ok: false, statusCode: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export type LinkScanSummary = { checked: number; broken: number; summary: string };

/**
 * The last scan's verdict for a page of resources, keyed by resource id.
 *
 * One query per page rather than per row. Ids with no entry have never been
 * scanned, which callers must treat as "unknown" and not as a pass.
 */
export async function linkStatesFor(ids: string[]): Promise<Map<string, LinkState>> {
  if (ids.length === 0) return new Map();
  const checks = await prisma.linkCheck.findMany({
    where: { resourceId: { in: ids } },
    select: { resourceId: true, ok: true, statusCode: true },
  });
  const out = new Map<string, LinkState>();
  for (const c of checks) {
    const state = linkState(c);
    if (state) out.set(c.resourceId, state);
  }
  return out;
}

/**
 * Scan every digital access URL and record per-resource results. Prunes
 * LinkCheck rows whose resource no longer has a URL, records a BatchRun, and
 * queues an alert email to active admins for every provider that scans DOWN.
 */
export async function runLinkCheckCore(ranBy: string): Promise<LinkScanSummary> {
  const resources = await prisma.resource.findMany({
    where: { digitalUrl: { not: null } },
    select: { id: true, title: true, digitalUrl: true },
  });

  let broken = 0;
  for (let i = 0; i < resources.length; i += SCAN_CONCURRENCY) {
    await Promise.all(
      resources.slice(i, i + SCAN_CONCURRENCY).map(async (r) => {
        const result = await checkUrl(r.digitalUrl!);
        if (!result.ok) broken++;
        await prisma.linkCheck.upsert({
          where: { resourceId: r.id },
          update: { url: r.digitalUrl!, ...result, checkedAt: new Date() },
          create: { resourceId: r.id, url: r.digitalUrl!, ...result },
        });
      }),
    );
  }

  // Prune stale rows (resource deleted or URL removed since the last scan).
  await prisma.linkCheck.deleteMany({
    where: { resourceId: { notIn: resources.map((r) => r.id) } },
  });

  const summary = `Checked ${resources.length} link${resources.length === 1 ? "" : "s"} · ${broken} broken`;
  await prisma.batchRun.create({ data: { process: "LINKCHECK", summary, ranBy } });

  // Provider-wide failure alerting: queue an outbox email per DOWN provider.
  const health = await getAccessHealth();
  const down = health.providers.filter((p) => p.status === "DOWN");
  if (down.length > 0) {
    const admins = await prisma.adminUser.findMany({
      where: { status: "ACTIVE" },
      select: { name: true, email: true },
    });
    for (const p of down) {
      const subject = `Access alert: ${p.provider} looks down (${p.broken}/${p.checked} links failing)`;
      const body = `The latest access scan found ${p.broken} of ${p.checked} ${p.provider} links failing${p.sampleError ? ` (most common error: ${p.sampleError})` : ""}.\n\nThis usually means a provider-side outage, an expired subscription, or a proxy/authentication change. Individual titles are unlikely to be at fault. Review the Access Health dashboard.`;
      await prisma.mailQueue.createMany({
        data: admins.map((a) => ({
          toEmail: a.email,
          toName: a.name,
          subject,
          body,
          template: "ACCESS_ALERT",
        })),
      });
    }
  }

  return { checked: resources.length, broken, summary };
}

/** Current health picture from the most recent scan results. */
export async function getAccessHealth(): Promise<AccessHealth> {
  const [checks, lastRun] = await Promise.all([
    prisma.linkCheck.findMany(),
    prisma.batchRun.findFirst({ where: { process: "LINKCHECK" }, orderBy: { ranAt: "desc" } }),
  ]);

  const resources = checks.length
    ? await prisma.resource.findMany({
        where: { id: { in: checks.map((c) => c.resourceId) } },
        select: { id: true, title: true, provider: true },
      })
    : [];
  const byId = new Map(resources.map((r) => [r.id, r]));

  const groups = new Map<
    string,
    { checked: number; broken: number; unverified: number; errors: string[] }
  >();
  const brokenList: AccessHealth["broken"] = [];
  let totalUnverified = 0;

  for (const c of checks) {
    const resource = byId.get(c.resourceId);
    if (!resource) continue; // resource deleted since the scan
    const provider = resource.provider ?? "Local collection";
    const g = groups.get(provider) ?? { checked: 0, broken: 0, unverified: 0, errors: [] };
    g.checked++;
    const state: LinkState | null = linkState(c);
    if (state === "UNVERIFIED") {
      g.unverified++;
      totalUnverified++;
    }
    if (!c.ok) {
      g.broken++;
      const err = c.error ?? (c.statusCode ? `HTTP ${c.statusCode}` : "Failed");
      g.errors.push(err);
      brokenList.push({
        resourceId: c.resourceId,
        title: resource.title,
        provider,
        url: c.url,
        error: err,
        checkedAt: c.checkedAt,
      });
    }
    groups.set(provider, g);
  }

  const providers: ProviderHealth[] = [...groups.entries()]
    .map(([provider, g]) => {
      const status: ProviderHealth["status"] =
        g.broken >= DOWN_MIN_BROKEN && g.broken / g.checked >= DOWN_RATIO
          ? "DOWN"
          : g.broken > 0
            ? "DEGRADED"
            : "HEALTHY";
      // Most common error string among this provider's failures.
      const counts = new Map<string, number>();
      for (const e of g.errors) counts.set(e, (counts.get(e) ?? 0) + 1);
      const sampleError = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      return {
        provider,
        checked: g.checked,
        broken: g.broken,
        unverified: g.unverified,
        // Confirmed retrievals only. An unverified link is not evidence of
        // health, so it must not pad this ratio: IEEE answering 202 to all 33
        // of its links would otherwise have read as a perfect score.
        okRatio: g.checked ? (g.checked - g.broken - g.unverified) / g.checked : 1,
        status,
        sampleError,
      };
    })
    // Broken first, because that is what needs a librarian today. Unverified
    // breaks the tie: it is worth a look, but a provider answering 202 to
    // everything is not "worse" than one with a dead link, and sorting on the
    // confirmed ratio alone would have put it at the top labelled HEALTHY.
    .sort(
      (a, b) =>
        b.broken / b.checked - a.broken / a.checked ||
        b.unverified / b.checked - a.unverified / a.checked ||
        b.checked - a.checked,
    );

  brokenList.sort((a, b) => a.provider.localeCompare(b.provider) || a.title.localeCompare(b.title));

  return {
    lastScanAt: lastRun?.ranAt ?? null,
    lastScanBy: lastRun?.ranBy ?? null,
    totalChecked: checks.length,
    totalBroken: brokenList.length,
    totalUnverified,
    providers,
    broken: brokenList,
  };
}
