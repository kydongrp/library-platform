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
