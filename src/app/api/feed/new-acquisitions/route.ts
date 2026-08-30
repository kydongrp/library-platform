import { prisma } from "@/lib/db";
import { buildRssFeed, type FeedItem } from "@/lib/feed";
import { portalResourceUrl } from "@/lib/portal-links";
import { proxiedUrl } from "@/lib/proxy-link";
import { linkStatesFor } from "@/lib/linkcheck";
import { rateLimit } from "@/lib/rate-limit";

/**
 * GET /api/feed/new-acquisitions: the catalogue's recent additions, as RSS.
 *
 * UNAUTHENTICATED, on purpose, and that is the whole design constraint.
 *
 * The portal API requires `Authorization: Bearer dls_live_…`, and a feed reader
 * has nowhere to put one: Wippli Signal's source configuration carries a URL
 * and nothing else. So either this endpoint is open or the catalogue cannot be
 * a source at all. It is open.
 *
 * What that costs is bounded by what it selects, not by what it renders, which
 * is why the select list below is explicit and short. It publishes the
 * bibliographic facts a library catalogue exists to announce (title, author,
 * publisher, year, type, subject headings) and nothing else. It never touches
 * Member, Loan, Reservation, AdminUser, AuditLog or ApiClient, and it cannot:
 * there is one query, against Resource, naming its columns.
 *
 * Three further limits, each deliberate:
 *
 *   Only digital, link-out titles with a public access URL are listed. A
 *   physical holding's shelf location and barcode are operational facts about
 *   this library, not bibliographic ones about the work, and they are of no use
 *   to a reader who cannot walk in.
 *
 *   A title whose access link the nightly scan found BROKEN is withheld. The
 *   library knows a reader clicking it gets a 404, and syndicating it would
 *   push that dead end into every downstream system that subscribes.
 *
 *   The response is capped and cached. An open endpoint is a free query against
 *   the database for anyone who finds it, so the row count is bounded, the page
 *   size cannot be widened past MAX_ITEMS, and a CDN answer serves the repeat
 *   traffic.
 *
 * PUBLIC_FEED_ENABLED must be set before it serves anything at all. See
 * feedEnabled below for why that default is the way round it is.
 *
 * ONE INVARIANT, and it is load-bearing: the MARC selection is pinned to tag
 * 650 and subfield $a. That single filter is what keeps the local 9XX block out
 * of a world-readable document, and 954 is Point of Contact, which carries a
 * name, an email and a department. Widening that where clause is the change
 * that turns this route from a policy question into a personal-data leak, so it
 * is asserted in scripts/test-feed.ts rather than left to whoever edits next.
 *
 * Note also what this publishes that the AUTHENTICATED portal API does not:
 * subject headings. The feed is narrower on everything else (no ISBN, no
 * language, no holdings, no licence seats), but on subjects it is wider, and
 * that asymmetry is deliberate because the headings are the reason a machine
 * would subscribe. It is a decision for KLSI, not an accident.
 */
export const dynamic = "force-dynamic";

const DEFAULT_ITEMS = 50;
const MAX_ITEMS = 200;

/**
 * Fail CLOSED, matching src/app/api/cron/_guard.ts.
 *
 * This defaulted to on, with a comment arguing that exposure "stays a decision
 * someone can reverse in one environment variable". That had it backwards: the
 * decision to EXPOSE was never made by anyone, and only the reversal required
 * an action. Any environment that had never heard of the variable, a new
 * preview, a staging deploy, the database after the Neon move, would have come
 * up syndicating the catalogue because nobody typed anything.
 *
 * Opting in to a public data-egress channel is the explicit act on an IM8
 * system, so it is the one that needs a keystroke.
 */
function feedEnabled(): boolean {
  const v = (process.env.PUBLIC_FEED_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

function siteOrigin(request: Request): string {
  // The deployment's own origin, so the links work on preview and production
  // alike without a second variable to keep in step.
  const configured = (process.env.PUBLIC_SITE_URL ?? "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  return new URL(request.url).origin;
}

export async function GET(request: Request) {
  if (!feedEnabled()) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  // The only unauthenticated route in the system, and so the only one where an
  // address is all the identity there is. Cache-Control was doing this job on
  // paper and cannot in practice: the CDN keys on the query string, so
  // ?limit=1, ?limit=2, ?anything walks straight past the cache to the origin.
  const ip =
    request.headers.get("x-real-ip") ??
    (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  if (!(await rateLimit(`feed:${ip}`, 30, 60))) {
    return new Response("Too many requests", {
      status: 429,
      headers: { "Content-Type": "text/plain", "Retry-After": "60" },
    });
  }

  const params = new URL(request.url).searchParams;
  const requested = Number.parseInt(params.get("limit") ?? "", 10);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), MAX_ITEMS)
    : DEFAULT_ITEMS;

  const origin = siteOrigin(request);

  // Over-fetch a little, because withholding broken links happens after the
  // query and would otherwise return a short page.
  const rows = await prisma.resource.findMany({
    // On digitalUrl alone, as linkcheck.ts does. Requiring digital=true too
    // dropped link-out records that carry a URL without the flag set, which
    // this file's own header says it publishes: a 200 with a short feed and
    // nothing on the wire to say anything was withheld.
    where: { digitalUrl: { not: null } },
    select: {
      id: true,
      title: true,
      subtitle: true,
      author: true,
      type: true,
      category: true,
      publisher: true,
      publishedYear: true,
      provider: true,
      digitalUrl: true,
      description: true,
      createdAt: true,
      marcFields: {
        where: { tag: "650" },
        select: { subfields: true },
        orderBy: { seq: "asc" },
        // The row count is capped; without this the per-row payload is not.
        take: 20,
      },
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit * 2, MAX_ITEMS * 2),
  });

  const states = await linkStatesFor(rows.map((r) => r.id));

  const items: FeedItem[] = rows
    .filter((r) => states.get(r.id) !== "BROKEN")
    .slice(0, limit)
    .map((r) => {
      const subjects = r.marcFields
        .flatMap((f) => (f.subfields as { code: string; value: string }[]) ?? [])
        .filter((s) => s.code === "a")
        .map((s) => s.value);

      // Provenance a reader can act on, assembled from what is already public
      // on the record page. No note, no internal remark, no staff name.
      const facts = [
        r.subtitle,
        r.publisher,
        r.publishedYear ? String(r.publishedYear) : null,
        r.provider ? `via ${r.provider}` : null,
      ].filter(Boolean);

      // NOT the admin record page: that is behind a login, so every item in a
      // public feed would dead-end at a sign-in redirect. The learner portal
      // when it is configured, otherwise the resource's own access URL, which
      // is where the work actually lives.
      const link = portalResourceUrl(r.id) ?? proxiedUrl(r.digitalUrl, r.provider) ?? origin;

      return {
        // Stable regardless of which of those the link resolved to today.
        id: `urn:dls:resource:${r.id}`,
        title: r.title,
        author: r.author,
        link,
        description: [r.description, facts.join(" · ")].filter(Boolean).join(". "),
        categories: [r.category, ...subjects].filter(Boolean),
        publishedAt: r.createdAt,
      };
    });

  const xml = buildRssFeed(items, {
    title: "DLS: New acquisitions",
    description:
      "Digital titles recently added to the Digital Library System, with their subject headings.",
    selfUrl: `${origin}/api/feed/new-acquisitions`,
    siteUrl: origin,
    now: new Date(),
  });

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      // Ten minutes at the edge, an hour of stale while it refreshes. Nothing
      // here is user-specific, so a shared cache is safe. This reduces cost for
      // well-behaved readers; it is not the abuse control, which is the rate
      // limit above, because a caller choosing its own query string never
      // shares a cache key with anyone.
      "Cache-Control": "public, s-maxage=600, stale-while-revalidate=3600",
      // Keeps the feed URL itself out of search results. It says nothing about
      // the destinations the feed links to, which are the publishers' own.
      "X-Robots-Tag": "noindex",
    },
  });
}
