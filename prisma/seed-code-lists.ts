/**
 * Idempotent code-list seed, run on EVERY deploy.
 *
 * Distinct from seed-if-empty.ts, which populates demo data only when the
 * database is empty. A code list is different: production already has data, and
 * a dropdown that is empty because its table was never seeded is a broken
 * screen, not a fresh start. So this runs every time and only inserts what is
 * missing.
 *
 * Existing rows are never touched, including any staff renamed or re-sorted.
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { SEED_CATEGORIES, UNCATEGORISED, SEED_MEMBER_TYPES } from "../src/lib/constants";
import { SEED_MEMBER_STATUSES, RETIRED_MEMBER_STATUSES } from "../src/lib/member-status";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main(): Promise<void> {
  // Uncategorised first: it is where every import lands, so it should sit at
  // the top of the list rather than alphabetically among the real subjects.
  const wanted = [UNCATEGORISED, ...SEED_CATEGORIES];

  let created = 0;
  for (const [i, name] of wanted.entries()) {
    const existing = await prisma.resourceCategory.findUnique({ where: { name } });
    if (existing) continue;
    await prisma.resourceCategory.create({ data: { name, sortOrder: i } });
    created++;
  }

  const total = await prisma.resourceCategory.count();
  console.log(
    created > 0
      ? `Code lists: added ${created} category/categories, ${total} in total.`
      : `Code lists: all ${total} categories already present.`,
  );

  // Member types. Labels ARE updated for existing rows, unlike names: the
  // wording is the client's and may be corrected, while the name is referenced
  // by Member.memberType and LoanPolicy.memberType and must never move.
  let typesAdded = 0;
  let labelsFixed = 0;
  for (const [i, t] of SEED_MEMBER_TYPES.entries()) {
    const existing = await prisma.memberTypeDef.findUnique({ where: { name: t.name } });
    if (!existing) {
      await prisma.memberTypeDef.create({ data: { name: t.name, label: t.label, sortOrder: i } });
      typesAdded++;
    } else if (existing.label !== t.label) {
      await prisma.memberTypeDef.update({ where: { name: t.name }, data: { label: t.label } });
      labelsFixed++;
    }
  }

  // Member statuses. `suspends` replaced the old canBorrow flag; carry the old
  // value across ONCE for rows that predate the change, so a status that
  // blocked borrowing keeps blocking it.
  let statusesAdded = 0;
  let carried = 0;
  for (const [i, st] of SEED_MEMBER_STATUSES.entries()) {
    const existing = await prisma.memberStatus.findUnique({ where: { name: st.name } });
    if (!existing) {
      await prisma.memberStatus.create({
        data: {
          name: st.name,
          suspends: st.suspends,
          autoAfterInactiveDays: st.autoAfterInactiveDays,
          isDefault: st.isDefault,
          canBorrow: !st.suspends,
        },
      });
      statusesAdded++;
    }
    void i;
  }

  // Rows created before `suspends` existed default to false, which would make a
  // previously blocking status permissive. Reconcile them from canBorrow once.
  const stale = await prisma.memberStatus.findMany({ where: { suspends: false, canBorrow: false } });
  for (const row of stale) {
    await prisma.memberStatus.update({ where: { id: row.id }, data: { suspends: true } });
    carried++;
  }

  // Retired statuses are removed from the list. Members already on one keep the
  // value, exactly as the other code lists behave; statusAllowsBorrowing treats
  // an unknown status as suspended, which matches what Alumni already did.
  let retired = 0;
  for (const name of RETIRED_MEMBER_STATUSES) {
    const row = await prisma.memberStatus.findUnique({ where: { name } });
    if (!row) continue;
    const inUse = await prisma.member.count({ where: { status: name } });
    await prisma.memberStatus.delete({ where: { id: row.id } });
    retired++;
    if (inUse > 0) {
      console.log(
        `Code lists: removed status "${name}"; ${inUse} member(s) keep it on their record and count as suspended.`,
      );
    }
  }

  console.log(
    `Code lists: ${statusesAdded} status(es) added, ${carried} carried from the old borrowing flag, ${retired} retired.`,
  );

  const typeTotal = await prisma.memberTypeDef.count();
  console.log(
    `Code lists: ${typesAdded} member type(s) added, ${labelsFixed} label(s) updated, ${typeTotal} in total.`,
  );
}

void main()
  .catch((e) => {
    console.error("Code-list seed failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
