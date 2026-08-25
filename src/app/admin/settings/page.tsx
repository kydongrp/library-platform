import Link from "next/link";
import { requireAdminView } from "@/lib/admin-guard";
import { canEdit } from "@/lib/admin-session";
import { prisma } from "@/lib/db";
import { GroupMatrix, NewGroupForm, AdminUsersSection } from "./sections";
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
  { key: "staff", label: "Staff accounts" },
  { key: "access", label: "Groups & access" },
  { key: "search", label: "Search vocabulary" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const BLURB: Record<TabKey, string> = {
  staff:
    "Who can sign in, and which group they belong to. A staff member inherits their group's rights; suspending an account takes effect on their next page load.",
  access:
    "What each group can see and change, per module. Ticking edit implies view, so a module can never be editable but invisible.",
  search:
    "Words the catalogue search ignores, and spellings that should find each other. These apply to the staff catalogue search, the catalogue export, and the Learner Portal search API.",
};

export default async function AdminSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const admin = await requireAdminView("ADMIN");
  const editable = canEdit(admin, "ADMIN");

  const requested = (await searchParams).tab;
  const tab: TabKey = TABS.some((t) => t.key === requested) ? (requested as TabKey) : "staff";

  // Counts for the pills are three cheap aggregates; the heavy reads below are
  // conditional on which tab is open.
  const [staffCount, groupCount, vocabCount] = await Promise.all([
    prisma.adminUser.count(),
    prisma.adminGroup.count(),
    Promise.all([prisma.stopWord.count(), prisma.variantSpelling.count()]).then(
      ([a, b]) => a + b,
    ),
  ]);
  const counts: Record<TabKey, number> = {
    staff: staffCount,
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

      {tab === "staff" && <StaffTab currentAdminId={admin.id} readOnly={!editable} />}
      {tab === "access" && <AccessTab readOnly={!editable} />}
      {tab === "search" && <SearchTab readOnly={!editable} />}
    </div>
  );
}

async function StaffTab({
  currentAdminId,
  readOnly,
}: {
  currentAdminId: string;
  readOnly: boolean;
}) {
  const [users, groups] = await Promise.all([
    prisma.adminUser.findMany({ include: { group: true }, orderBy: { name: "asc" } }),
    // Only the id and name: this feeds the group dropdown, not the matrix.
    prisma.adminGroup.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <AdminUsersSection
      users={users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        status: u.status,
        groupId: u.groupId,
        groupName: u.group.name,
      }))}
      groups={groups}
      currentAdminId={currentAdminId}
      readOnly={readOnly}
    />
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
