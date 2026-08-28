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
import { SEED_CATEGORIES, UNCATEGORISED } from "../src/lib/constants";

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
}

void main()
  .catch((e) => {
    console.error("Code-list seed failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
