// One-off backfill for the contract-compliance slice: new templates, the
// REQUESTS admin area, and demo licence seats. Safe to re-run (idempotent).
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { DEFAULT_TEMPLATES } from "../src/lib/template-defs";

const adapter = new PrismaPg({
  connectionString: process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL,
});
const prisma = new PrismaClient({ adapter });

async function main() {
  // 1. New templates (RECALL, DIGITAL_AVAILABLE, REQUEST_UPDATE).
  for (const t of DEFAULT_TEMPLATES) {
    await prisma.emailTemplate.upsert({
      where: { code: t.code },
      update: {},
      create: {
        code: t.code,
        name: t.name,
        subject: t.subject,
        body: t.body,
        inAppEnabled: true,
        emailEnabled: t.emailEnabled ?? false,
      },
    });
  }

  // 2. REQUESTS area permissions per group.
  const groups = await prisma.adminGroup.findMany();
  for (const g of groups) {
    const grant = g.name === "Administrators" || g.name === "Librarians";
    await prisma.adminGroupPermission.upsert({
      where: { groupId_area: { groupId: g.id, area: "REQUESTS" } },
      update: {},
      create: { groupId: g.id, area: "REQUESTS", canView: grant, canEdit: grant },
    });
  }

  // 3. Demo licence seats on two digital titles.
  await prisma.resource.updateMany({
    where: { title: "Designing Data-Intensive Applications" },
    data: { licenseSeats: 1 },
  });
  await prisma.resource.updateMany({
    where: { title: "The Three-Body Problem" },
    data: { licenseSeats: 2 },
  });

  console.log("Backfill done:", {
    templates: await prisma.emailTemplate.count(),
    requestPerms: await prisma.adminGroupPermission.count({ where: { area: "REQUESTS" } }),
    seatTitles: await prisma.resource.count({ where: { licenseSeats: { not: null } } }),
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
