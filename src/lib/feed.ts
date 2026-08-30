/**
 * RSS 2.0 for the public new-acquisitions feed.
 *
 * Built because Wippli Signal, and anything else that reads feeds, has nowhere
 * to send an API key: its source configuration carries a URL and nothing else.
 * The portal API answers `Authorization: Bearer dls_live_…` or 401, so there
 * was no configuration that could ever have worked.
 *
 * RSS rather than JSON on purpose. Signal's rss collector is proven against
 * this shape (four public feeds ingested 115 items on their first run), while
 * its api collector accepted a JSON body and extracted nothing from it. A feed
 * nobody can parse is the same as no feed.
 *
 * Pure: no database, no request, no env. The route decides what goes in; this
 * decides only how it is written down, which is what makes the escaping
 * testable rather than hoped for.
 */

export type FeedItem = {
  /** Stable across rebuilds: it is the guid a reader dedupes on. */
  /**
   * Stable identity, independent of where the item currently links.
   * A guid that changes when a URL is reconfigured makes every subscriber
   * re-ingest the whole collection as if it were new.
   */
  id: string;
  title: string;
  author: string;
  /** Where a reader goes. May change; the guid does not. */
  link: string;
  description: string;
  /** Subject headings, published as <category>. */
  categories: string[];
  publishedAt: Date;
};

export type FeedOptions = {
  title: string;
  description: string;
  /** Absolute URL of the feed itself, for atom:link rel=self. */
  selfUrl: string;
  /** Absolute URL of the thing the feed is about. */
  siteUrl: string;
  now: Date;
};

/**
 * Escape text for XML character data.
 *
 * The five predefined entities, and then a sweep for control characters. A
 * catalogue record is data somebody typed, and a title holding an ampersand or
 * a stray 0x0B byte is not exotic: it is Tuesday. An unescaped one produces a
 * document no parser will read, which fails as silently as anything in this
 * system can, because the feed still returns 200.
 */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // XML 1.0 allows tab, newline and carriage return, and nothing else below
    // 0x20. Everything outside that is dropped rather than escaped, because
    // there is no legal escape for it.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/g, "");
}

/** RFC 822 date, which RSS requires and ISO 8601 is not. */
export function rfc822(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const p = (n: number) => String(n).padStart(2, "0");
  // Deliberately UTC, and deliberately not through the zone layer. An RSS
  // pubDate is an instant carrying its own offset, so every reader anywhere
  // resolves it identically; nothing here is a calendar day in the library's
  // zone. Read on one line so the exemption covers exactly what it claims.
  // tz-guard-allow: an RSS pubDate is an instant with an explicit +0000, not a calendar day
  const u = { wd: date.getUTCDay(), d: date.getUTCDate(), mo: date.getUTCMonth(), y: date.getUTCFullYear(), h: date.getUTCHours(), mi: date.getUTCMinutes(), s: date.getUTCSeconds() };
  return `${days[u.wd]}, ${p(u.d)} ${months[u.mo]} ${u.y} ${p(u.h)}:${p(u.mi)}:${p(u.s)} +0000`;
}

/**
 * One-line plain text, clipped on a word boundary where it can be.
 *
 * The result is never longer than `max`, ellipsis included. The first version
 * sliced to exactly `max` and then appended the ellipsis, so every hard clip
 * returned max+1 and the length assertion in the tests could not fail.
 *
 * Code points, not code units: slicing a string mid-surrogate leaves half an
 * astral character, which xmlEscape does not strip and which reaches the reader
 * as a replacement character.
 */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  if (chars.length <= max) return flat;
  if (max < 1) return "";

  const room = max - 1; // the ellipsis occupies one
  // One past the limit, so a space sitting exactly at the cut is seen and the
  // word before it survives whole instead of being clipped a word early.
  const window = chars.slice(0, room + 1).join("");
  const lastSpace = window.lastIndexOf(" ");
  const body = lastSpace > room * 0.6 ? window.slice(0, lastSpace) : chars.slice(0, room).join("");
  return `${body.trimEnd()}…`;
}

/**
 * Render an RSS 2.0 document.
 *
 * The guid is a urn built from the record id, not the link, with isPermaLink
 * false. A reader polling hourly dedupes on it, and it survives the link being
 * repointed, at the learner portal once that is configured for instance,
 * which a URL-shaped guid would not.
 */
export function buildRssFeed(items: FeedItem[], opts: FeedOptions): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    "  <channel>",
    `    <title>${xmlEscape(opts.title)}</title>`,
    `    <link>${xmlEscape(opts.siteUrl)}</link>`,
    `    <description>${xmlEscape(opts.description)}</description>`,
    `    <atom:link href="${xmlEscape(opts.selfUrl)}" rel="self" type="application/rss+xml"/>`,
    "    <language>en</language>",
    `    <lastBuildDate>${rfc822(opts.now)}</lastBuildDate>`,
    `    <generator>Athenaeum</generator>`,
  ];

  for (const item of items) {
    lines.push(
      "    <item>",
      `      <title>${xmlEscape(clip(item.title, 300))}</title>`,
      `      <link>${xmlEscape(item.link)}</link>`,
      `      <guid isPermaLink="false">${xmlEscape(item.id)}</guid>`,
      `      <pubDate>${rfc822(item.publishedAt)}</pubDate>`,
      `      <description>${xmlEscape(clip(item.description, 1200))}</description>`,
    );
    if (item.author.trim()) {
      // dc:creator, not <author>: RSS's own author element is specified as an
      // email address, and a cataloguer's "Vaswani, Ashish, et al." is not one.
      lines.push(`      <dc:creator>${xmlEscape(clip(item.author, 300))}</dc:creator>`);
    }
    for (const category of item.categories) {
      lines.push(`      <category>${xmlEscape(clip(category, 200))}</category>`);
    }
    lines.push("    </item>");
  }

  lines.push("  </channel>", "</rss>", "");
  return lines.join("\n");
}
