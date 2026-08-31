/**
 * Which catalogue access links serve a PDF, and which serve a landing page.
 *
 *   npx tsx --env-file=.env scripts/survey-access-formats.ts
 *   npx tsx --env-file=.env scripts/survey-access-formats.ts --category Defence
 *   npx tsx --env-file=.env scripts/survey-access-formats.ts --category Defence --out pdfs.txt
 *
 * The catalogue records a digitalUrl without recording what is at the other end
 * of it. In practice the collection mixes two quite different things: a direct
 * PDF a reader gets in one click, and a publisher landing page they have to
 * navigate. Both are legitimate catalogue links, and a reader compiling a
 * reading pack cares which is which.
 *
 * So this fetches each link and reports the format actually served, reusing
 * checkUrl from verify-acquisition-links.ts rather than re-deriving it, which
 * also means it inherits the curl retry for publishers that refuse Node's
 * fetch on client fingerprint alone.
 *
 * Read-only: it selects from Resource and writes nothing.
 */
import { writeFileSync } from "node:fs";
import { prisma } from "../src/lib/db";
import { checkUrl, type Result } from "./verify-acquisition-links";

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const CATEGORY = flag("category");
const OUT = flag("out");
const CONCURRENCY = 6;

void (async () => {
  const rows = await prisma.resource.findMany({
    where: {
      digitalUrl: { not: null },
      ...(CATEGORY ? { category: CATEGORY } : {}),
    },
    select: { id: true, title: true, digitalUrl: true, publishedYear: true, category: true },
    orderBy: [{ publishedYear: "desc" }, { title: "asc" }],
  });

  console.log(
    `${rows.length} access link(s)${CATEGORY ? ` in category ${CATEGORY}` : ""}, checking what each serves\n`,
  );

  const results: (Result & { id: string; year: number | null })[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= rows.length) return;
        const r = rows[i];
        const res = await checkUrl({ title: r.title, url: r.digitalUrl! }, i + 1);
        results.push({ ...res, id: r.id, year: r.publishedYear });
        const fmt = res.kind === "pdf" ? "PDF " : res.kind === "html" ? "page" : "?   ";
        console.log(
          `  ${fmt} ${res.verdict === "DOCUMENT" ? "ok  " : "**  "} ` +
            `${r.title.slice(0, 52).padEnd(52)} ${res.note.slice(0, 40)}`,
        );
      }
    }),
  );

  results.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title));
  const pdfs = results.filter((r) => r.kind === "pdf");
  const pages = results.filter((r) => r.kind === "html");
  const other = results.filter((r) => r.kind !== "pdf" && r.kind !== "html");
  const failed = results.filter((r) => r.verdict !== "DOCUMENT");

  console.log(`\n${results.length} links: ${pdfs.length} serve a PDF, ${pages.length} serve a page, ${other.length} other.`);
  if (failed.length) {
    console.log(`${failed.length} did not serve a document at all:`);
    for (const r of failed) console.log(`  ${r.verdict.padEnd(14)} ${r.title.slice(0, 60)}`);
  }

  console.log(`\n=== DIRECT PDF LINKS (${pdfs.length}) ===\n`);
  const lines: string[] = [];
  for (const r of pdfs) {
    const mb = (r.bytes / 1024 / 1024).toFixed(1);
    console.log(`${r.title}`);
    console.log(`  ${r.year ?? "----"} · ${mb} MB${r.transport === "curl" ? " · needs a browser-like client" : ""}`);
    console.log(`  ${r.url}\n`);
    lines.push(`${r.title}\n${r.url}\n`);
  }

  if (pages.length) {
    console.log(`=== LANDING PAGES, no direct PDF (${pages.length}) ===\n`);
    for (const r of pages) console.log(`  ${r.title.slice(0, 62).padEnd(62)} ${r.url}`);
  }

  if (OUT) {
    writeFileSync(OUT, lines.join("\n"), "utf8");
    console.log(`\nwrote ${OUT}`);
  }
  await prisma.$disconnect();
})();
