import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { GroupMatrix, NewGroupForm } from "./sections";
import { SearchConfigSection } from "./search-config";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ tab?: string }>;

/**
 * Three unrelated jobs used to share one scroll: staff accounts, the group
 * access matrix, and the catalogue search vocabulary. They are split into
 * URL-driven tabs, the same idiom Current Loans uses, rather than into three
 * routes: it stays one page, one sidebar entry and one permission area, and a
 * tab is still linkable and survives a refresh.
 *
 * Each tab also loads only its own data. The page previously ran all four
 * queries on every visit, including pulling every group's full permission
 * matrix in order to render a name in a dropdown.
 */
const TABS = [
  { key: "access", label: "Groups & access" },
  { key: "search", label: "Search vocabulary" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const BLURB: Record<TabKey, string> = {
  access:
    "What each group can see and change, per module. Ticking edit implies view, so a module can never be editable but invisible.",
  search:
    "Words the catalogue search ignores, and spellings that should find each other. These apply to the staff catalogue search, the catalogue export, and the Learner Portal search API.",
};

export default async function AdminSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const admin = await requireAdminView("ADMIN");
  const editable = canEdit(admin, "ADMIN");

  const requested = (await searchParams).tab;
  const tab: TabKey = TABS.some((t) => t.key === requested) ? (requested as TabKey) : "access";

  // Counts for the pills are cheap aggregates; the heavy reads below are
  // conditional on which tab is open.
  const [groupCount, vocabCount] = await Promise.all([
    prisma.adminGroup.count(),
    Promise.all([prisma.stopWord.count(), prisma.variantSpelling.count()]).then(
      ([a, b]) => a + b,
    ),
  ]);
  const counts: Record<TabKey, number> = {
    access: groupCount,
    search: vocabCount,
  };

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-5">
        <h1 className="font-display text-3xl font-semibold">Admin Settings</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{BLURB[tab]}</p>
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/admin/settings?tab=${t.key}`}
            aria-current={tab === t.key ? "page" : undefined}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label} ({counts[t.key]})
          </Link>
        ))}
      </div>

      {tab === "access" && <AccessTab readOnly={!editable} />}
      {tab === "search" && <SearchTab readOnly={!editable} />}
    </div>
  );
}

async function AccessTab({ readOnly }: { readOnly: boolean }) {
  const groups = await prisma.adminGroup.findMany({
    include: { permissions: true, _count: { select: { users: true } } },
    orderBy: { name: "asc" },
  });

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-display text-xl font-semibold">Admin groups &amp; access matrix</h2>
        {!readOnly && <NewGroupForm />}
      </div>
      <div className="space-y-4">
        {groups.map((g) => (
          <GroupMatrix
            key={g.id}
            group={{
              id: g.id,
              name: g.name,
              description: g.description,
              userCount: g._count.users,
              permissions: g.permissions.map((p) => ({
                area: p.area,
                canView: p.canView,
                canEdit: p.canEdit,
              })),
            }}
            readOnly={readOnly}
          />
        ))}
      </div>
    </>
  );
}

async function SearchTab({ readOnly }: { readOnly: boolean }) {
  const [stopWords, variants] = await Promise.all([
    prisma.stopWord.findMany({ orderBy: { word: "asc" } }),
    prisma.variantSpelling.findMany({ orderBy: [{ word: "asc" }, { variant: "asc" }] }),
  ]);

  return (
    <SearchConfigSection
      stopWords={stopWords.map((w) => ({ id: w.id, word: w.word }))}
      variants={variants.map((v) => ({ id: v.id, word: v.word, variant: v.variant }))}
      readOnly={readOnly}
    />
  );
}
