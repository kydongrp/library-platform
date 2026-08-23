import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prefer the direct (non-pooled) connection for DDL/bulk writes; the pooled
// connection (via pgBouncer) can choke on prepared statements. Falls back to
// DATABASE_URL for local dev where only that is set.
const connectionString =
  process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const DAY = 24 * 60 * 60 * 1000;

type Seed = {
  title: string;
  subtitle?: string;
  author: string;
  isbn?: string;
  type: string;
  /** MONOGRAPH | SERIAL — omitted means "derive from type". */
  materialDesignation?: string;
  category: string;
  publisher?: string;
  publishedYear?: number;
  description?: string;
  coverColor: string;
  digital?: boolean;
  provider?: string; // external subscription source (e.g. "IEEE Xplore")
  digitalUrl?: string;
  licenseSeats?: number; // concurrent-user cap for digital titles
  copies: number; // physical copies (digital titles use 0)
};

const RESOURCES: Seed[] = [
  {
    title: "The Pragmatic Programmer",
    subtitle: "Your Journey to Mastery",
    author: "Andrew Hunt, David Thomas",
    isbn: "9780135957059",
    type: "BOOK",
    category: "Technology",
    publisher: "Addison-Wesley",
    publishedYear: 2019,
    description:
      "A classic guide to the craft of software development, full of practical advice on writing flexible, maintainable code.",
    coverColor: "#0f766e",
    copies: 3,
  },
  {
    title: "Clean Code",
    subtitle: "A Handbook of Agile Software Craftsmanship",
    author: "Robert C. Martin",
    isbn: "9780132350884",
    type: "BOOK",
    category: "Technology",
    publisher: "Prentice Hall",
    publishedYear: 2008,
    description:
      "Principles, patterns, and practices for writing clean, readable code that other engineers can build on.",
    coverColor: "#1e3a8a",
    copies: 2,
  },
  {
    title: "Designing Data-Intensive Applications",
    author: "Martin Kleppmann",
    isbn: "9781449373320",
    type: "EBOOK",
    category: "Technology",
    publisher: "O'Reilly Media",
    publishedYear: 2017,
    description:
      "The big ideas behind reliable, scalable, and maintainable systems — storage engines, replication, and distributed data.",
    coverColor: "#9a3412",
    digital: true,
    licenseSeats: 1, // demo: single concurrent-user licence → exercises the digital queue
    copies: 0,
  },
  {
    title: "Thinking, Fast and Slow",
    author: "Daniel Kahneman",
    isbn: "9780374533557",
    type: "BOOK",
    category: "Science",
    publisher: "Farrar, Straus and Giroux",
    publishedYear: 2011,
    description:
      "A Nobel laureate's tour of the two systems that drive the way we think — fast intuition and slow reasoning.",
    coverColor: "#374151",
    copies: 2,
  },
  {
    title: "Sapiens",
    subtitle: "A Brief History of Humankind",
    author: "Yuval Noah Harari",
    isbn: "9780062316097",
    type: "BOOK",
    category: "History",
    publisher: "Harper",
    publishedYear: 2015,
    description:
      "How an unremarkable ape came to dominate the planet — a sweeping account of the cognitive, agricultural, and scientific revolutions.",
    coverColor: "#b45309",
    copies: 4,
  },
  {
    title: "Educated",
    subtitle: "A Memoir",
    author: "Tara Westover",
    isbn: "9780399590504",
    type: "AUDIOBOOK",
    category: "History",
    publisher: "Random House",
    publishedYear: 2018,
    description:
      "A memoir about a young woman who leaves her survivalist family and goes on to earn a PhD from Cambridge.",
    coverColor: "#7c2d12",
    digital: true,
    copies: 0,
  },
  {
    title: "The Lean Startup",
    author: "Eric Ries",
    isbn: "9780307887894",
    type: "BOOK",
    category: "Business",
    publisher: "Crown Business",
    publishedYear: 2011,
    description:
      "How today's entrepreneurs use continuous innovation to create radically successful businesses.",
    coverColor: "#065f46",
    copies: 2,
  },
  {
    title: "Zero to One",
    subtitle: "Notes on Startups, or How to Build the Future",
    author: "Peter Thiel, Blake Masters",
    isbn: "9780804139298",
    type: "EBOOK",
    category: "Business",
    publisher: "Crown Business",
    publishedYear: 2014,
    description:
      "A contrarian's guide to building companies that create new things rather than copying what works.",
    coverColor: "#1f2937",
    digital: true,
    copies: 0,
  },
  {
    title: "A Brief History of Time",
    author: "Stephen Hawking",
    isbn: "9780553380163",
    type: "BOOK",
    category: "Science",
    publisher: "Bantam",
    publishedYear: 1998,
    description:
      "From the Big Bang to black holes, a landmark exploration of the universe written for the general reader.",
    coverColor: "#312e81",
    copies: 2,
  },
  {
    title: "The Design of Everyday Things",
    author: "Don Norman",
    isbn: "9780465050659",
    type: "BOOK",
    category: "Arts",
    publisher: "Basic Books",
    publishedYear: 2013,
    description:
      "Why some products satisfy while others frustrate — a foundational text on human-centered design.",
    coverColor: "#be123c",
    copies: 3,
  },
  {
    title: "Steal Like an Artist",
    author: "Austin Kleon",
    isbn: "9780761169253",
    type: "BOOK",
    category: "Arts",
    publisher: "Workman",
    publishedYear: 2012,
    description:
      "Ten things nobody told you about being creative, illustrated and to the point.",
    coverColor: "#a21caf",
    copies: 2,
  },
  {
    title: "Why We Sleep",
    subtitle: "Unlocking the Power of Sleep and Dreams",
    author: "Matthew Walker",
    isbn: "9781501144318",
    type: "BOOK",
    category: "Health",
    publisher: "Scribner",
    publishedYear: 2017,
    description:
      "A neuroscientist's case for sleep as the single most effective thing we can do to reset brain and body health.",
    coverColor: "#0e7490",
    copies: 2,
  },
  {
    title: "The Body",
    subtitle: "A Guide for Occupants",
    author: "Bill Bryson",
    isbn: "9780385539302",
    type: "BOOK",
    category: "Health",
    publisher: "Doubleday",
    publishedYear: 2019,
    description:
      "A head-to-toe tour of the human body, full of wit and astonishing facts.",
    coverColor: "#15803d",
    copies: 1,
  },
  {
    title: "Dune",
    author: "Frank Herbert",
    isbn: "9780441013593",
    type: "BOOK",
    category: "Fiction",
    publisher: "Ace",
    publishedYear: 1965,
    description:
      "The desert planet Arrakis, the spice melange, and a young heir's rise — the cornerstone of modern science fiction.",
    coverColor: "#92400e",
    copies: 3,
  },
  {
    title: "The Three-Body Problem",
    author: "Liu Cixin",
    isbn: "9780765382030",
    type: "EBOOK",
    category: "Fiction",
    publisher: "Tor Books",
    publishedYear: 2014,
    description:
      "First contact, hard science, and civilizational stakes in an award-winning Chinese science fiction trilogy opener.",
    coverColor: "#155e75",
    digital: true,
    licenseSeats: 2,
    copies: 0,
  },
  {
    title: "Project Hail Mary",
    author: "Andy Weir",
    isbn: "9780593135204",
    type: "AUDIOBOOK",
    category: "Fiction",
    publisher: "Ballantine Books",
    publishedYear: 2021,
    description:
      "A lone astronaut wakes with no memory and the fate of humanity resting on a problem only he can solve.",
    coverColor: "#1d4ed8",
    digital: true,
    copies: 0,
  },
  {
    title: "Atomic Habits",
    subtitle: "An Easy & Proven Way to Build Good Habits",
    author: "James Clear",
    isbn: "9780735211292",
    type: "BOOK",
    category: "Business",
    publisher: "Avery",
    publishedYear: 2018,
    description:
      "Tiny changes, remarkable results — a practical framework for improving every day.",
    coverColor: "#ca8a04",
    copies: 4,
  },
  {
    title: "Nature",
    subtitle: "International Weekly Journal of Science",
    author: "Springer Nature",
    type: "JOURNAL",
    materialDesignation: "SERIAL",
    category: "Science",
    publisher: "Springer Nature",
    publishedYear: 2024,
    description:
      "Peer-reviewed research across the natural sciences. Latest issues available in the periodicals section.",
    coverColor: "#047857",
    copies: 1,
  },
  {
    title: "The Pragmatist's Guide to Leadership",
    author: "Susan Okafor",
    type: "BOOK",
    category: "Business",
    publisher: "Meridian Press",
    publishedYear: 2022,
    description:
      "Field-tested approaches to leading teams through ambiguity, written for new and seasoned managers alike.",
    coverColor: "#6d28d9",
    copies: 2,
  },

  // --- IEEE publications & other research databases (externally subscribed) ---
  {
    title: "IEEE Transactions on Software Engineering",
    author: "IEEE Computer Society",
    type: "JOURNAL",
    materialDesignation: "SERIAL",
    category: "Technology",
    publisher: "IEEE",
    publishedYear: 2024,
    description:
      "Archival research on the specification, development, management, and maintenance of software systems.",
    coverColor: "#00629b",
    digital: true,
    provider: "IEEE Xplore",
    digitalUrl: "https://ieeexplore.ieee.org/xpl/RecentIssue.jsp?punumber=32",
    copies: 0,
  },
  {
    title: "IEEE Transactions on Neural Networks and Learning Systems",
    author: "IEEE Computational Intelligence Society",
    type: "JOURNAL",
    materialDesignation: "SERIAL",
    category: "Science",
    publisher: "IEEE",
    publishedYear: 2024,
    description:
      "Theory, design, and applications of neural networks and related learning systems.",
    coverColor: "#003b5c",
    digital: true,
    provider: "IEEE Xplore",
    digitalUrl: "https://ieeexplore.ieee.org/xpl/RecentIssue.jsp?punumber=5962385",
    copies: 0,
  },
  {
    title: "Deep Residual Learning for Image Recognition",
    subtitle: "Proceedings of the IEEE Conference on Computer Vision (CVPR)",
    author: "Kaiming He, Xiangyu Zhang, Shaoqing Ren, Jian Sun",
    type: "CONFERENCE",
    category: "Technology",
    publisher: "IEEE",
    publishedYear: 2016,
    description:
      "The landmark ResNet paper introducing residual learning frameworks for training very deep networks.",
    coverColor: "#1c3f6e",
    digital: true,
    provider: "IEEE Xplore",
    digitalUrl: "https://ieeexplore.ieee.org/document/7780459",
    copies: 0,
  },
  {
    title: "IEEE Std 802.11-2020",
    subtitle: "Wireless LAN Medium Access Control (MAC) and Physical Layer (PHY) Specifications",
    author: "IEEE 802.11 Working Group",
    type: "STANDARD",
    category: "Technology",
    publisher: "IEEE Standards Association",
    publishedYear: 2021,
    description:
      "The foundational standard defining Wi-Fi MAC and PHY layers for wireless local area networks.",
    coverColor: "#0b2e4f",
    digital: true,
    provider: "IEEE Xplore",
    digitalUrl: "https://ieeexplore.ieee.org/document/9363693",
    copies: 0,
  },
  {
    title: "IEEE Spectrum",
    author: "IEEE",
    type: "MAGAZINE",
    materialDesignation: "SERIAL",
    category: "Technology",
    publisher: "IEEE",
    publishedYear: 2024,
    description:
      "IEEE's flagship magazine covering developments in technology, engineering, and applied science.",
    coverColor: "#0073ae",
    digital: true,
    provider: "IEEE Xplore",
    digitalUrl: "https://ieeexplore.ieee.org/xpl/RecentIssue.jsp?punumber=6",
    copies: 0,
  },
  {
    title: "IEEE Transactions on Power Systems",
    author: "IEEE Power & Energy Society",
    type: "JOURNAL",
    materialDesignation: "SERIAL",
    category: "Science",
    publisher: "IEEE",
    publishedYear: 2024,
    description:
      "Research on the planning, operation, and control of electric power systems.",
    coverColor: "#005a8c",
    digital: true,
    provider: "IEEE Xplore",
    digitalUrl: "https://ieeexplore.ieee.org/xpl/RecentIssue.jsp?punumber=59",
    copies: 0,
  },
  {
    title: "Attention Is All You Need",
    subtitle: "Advances in Neural Information Processing Systems",
    author: "Ashish Vaswani, et al.",
    type: "CONFERENCE",
    category: "Technology",
    publisher: "ACM",
    publishedYear: 2017,
    description:
      "Introduces the Transformer architecture, dispensing with recurrence in favour of self-attention.",
    coverColor: "#1d4044",
    digital: true,
    provider: "ACM Digital Library",
    digitalUrl: "https://dl.acm.org/doi/10.5555/3295222.3295349",
    copies: 0,
  },
  {
    title: "The Structure of Scientific Revolutions Revisited",
    author: "Journal of the History of Ideas",
    type: "JOURNAL",
    materialDesignation: "SERIAL",
    category: "History",
    publisher: "University of Pennsylvania Press",
    publishedYear: 2019,
    description:
      "A scholarly retrospective on paradigm shifts in the philosophy and history of science.",
    coverColor: "#7a3b2e",
    digital: true,
    provider: "JSTOR",
    digitalUrl: "https://www.jstor.org/",
    copies: 0,
  },
];

const MEMBERS = [
  { name: "Alice Tan", email: "alice.tan@example.edu", memberType: "STUDENT" },
  { name: "Bryan Lee", email: "bryan.lee@example.edu", memberType: "STUDENT" },
  { name: "Chloe Wong", email: "chloe.wong@example.edu", memberType: "STUDENT" },
  { name: "Dr. Devi Raman", email: "devi.raman@example.edu", memberType: "STAFF", maxLoans: 10 },
  { name: "Ethan Goh", email: "ethan.goh@example.edu", memberType: "STAFF", maxLoans: 10 },
  { name: "Farah Idris", email: "farah.idris@example.com", memberType: "EXTERNAL", maxLoans: 3 },
  { name: "George Mehta", email: "george.mehta@example.edu", memberType: "STUDENT" },
  { name: "Hana Kimura", email: "hana.kimura@example.edu", memberType: "STUDENT" },
];

/**
 * Service calendar — ensured on EVERY run (idempotent). Only FIXED-DATE
 * Singapore public holidays are seeded: the lunar and Islamic holidays
 * (Chinese New Year, Good Friday, Hari Raya, Vesak, Deepavali) shift each
 * year and are gazetted by MOM, so staff add those on the Calendar page
 * rather than have the seed guess them wrong and skew due dates.
 */
async function ensureServiceCalendar() {
  await prisma.serviceCalendar.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", closedWeekdays: [0] }, // closed Sundays
    update: {},
  });

  const year = new Date().getUTCFullYear();
  const fixed = [
    { md: "01-01", name: "New Year's Day" },
    { md: "05-01", name: "Labour Day" },
    { md: "08-09", name: "National Day" },
    { md: "12-25", name: "Christmas Day" },
  ];
  for (const y of [year, year + 1]) {
    for (const h of fixed) {
      const date = new Date(`${y}-${h.md}T12:00:00Z`);
      await prisma.libraryClosure.upsert({
        where: { date },
        create: { date, name: h.name, createdBy: "seed" },
        update: {},
      });
    }
  }
}

/**
 * Backfills for rows that predate a column — idempotent, runs on EVERY deploy.
 * Without these, a live database silently reports every historical loan as
 * on-time and every serial as a monograph.
 */
async function ensureBackfills() {
  // Loans returned before return-tracking shipped: derive timeliness from the
  // dates (null carries no information, so this can only add truth).
  const legacyLoans = await prisma.loan.findMany({
    where: { status: "RETURNED", returnStatus: null },
    select: { id: true, dueAt: true, returnedAt: true },
  });
  for (const l of legacyLoans) {
    const late = !!l.returnedAt && l.returnedAt.getTime() > l.dueAt.getTime();
    await prisma.loan.update({
      where: { id: l.id },
      data: { returnStatus: late ? "LATE" : "ON_TIME", returnCondition: "GOOD" },
    });
  }
  if (legacyLoans.length)
    console.log(`Backfilled returnStatus on ${legacyLoans.length} returned loan(s).`);

  // Material designation: only when the catalogue has never been designated
  // at all, so a cataloguer's deliberate MONOGRAPH on a journal is never
  // stomped on a later deploy.
  const anySerial = await prisma.resource.count({ where: { materialDesignation: "SERIAL" } });
  if (anySerial === 0) {
    const r = await prisma.resource.updateMany({
      where: { type: { in: ["JOURNAL", "MAGAZINE", "NEWSPAPER"] } },
      data: { materialDesignation: "SERIAL" },
    });
    if (r.count) console.log(`Backfilled materialDesignation on ${r.count} serial record(s).`);
  }
}

/**
 * MARC tag definitions — ensured on EVERY run. The cataloguing editor is
 * unusable without them, and staff edits are preserved (update is empty).
 */
async function ensureMarcTagDefs() {
  const { DEFAULT_TAG_DEFS } = await import("../src/lib/marc-tags");
  for (const d of DEFAULT_TAG_DEFS) {
    await prisma.marcTagDef.upsert({
      where: { tag: d.tag },
      create: {
        tag: d.tag, alias: d.alias ?? null, label: d.label,
        description: d.description ?? null, repeatable: d.repeatable ?? false,
        isControl: d.isControl ?? false, local: d.local ?? false,
        subfields: d.subfields ?? [], sortOrder: d.sortOrder,
      },
      update: {},
    });
  }
}

/**
 * Item-level code lists — ensured on EVERY run. Item types are what the loan
 * policy matrix keys on, so an empty table would leave the matrix unusable.
 */
async function ensureItemCodeLists() {
  const collections = [
    { code: "GEN", name: "General collection" },
    { code: "REF", name: "Reference", loanLimitOverride: 0 },
    { code: "RESERVE", name: "Course reserve", loanLimitOverride: 2 },
  ];
  for (const c of collections)
    await prisma.itemCollection.upsert({ where: { code: c.code }, create: c, update: {} });

  const locations = [
    { code: "MAIN", name: "Main Shelf" },
    { code: "L2", name: "Level 2 Reading Room" },
    { code: "STORE", name: "Closed store" },
  ];
  for (const l of locations)
    await prisma.itemLocation.upsert({ where: { code: l.code }, create: l, update: {} });

  const types = [
    { code: "BOOK", name: "Book", loanable: true },
    { code: "AV", name: "Audio-visual", loanable: true },
    { code: "REFONLY", name: "Reference only", loanable: false },
  ];
  for (const t of types)
    await prisma.itemType.upsert({ where: { code: t.code }, create: t, update: {} });
}

/** Built-in member statuses — ensured on EVERY run (idempotent), since the
 *  circulation gate and member forms rely on the table being populated. */
async function ensureMemberStatuses() {
  for (const s of [
    { name: "Active", canBorrow: true, isDefault: true, note: "Built-in default" },
    { name: "Suspended", canBorrow: false, isDefault: false, note: "Built-in: borrowing blocked" },
  ]) {
    await prisma.memberStatus.upsert({ where: { name: s.name }, create: s, update: {} });
  }
}

// Email templates are only created by the destructive seed path, so a NEW
// template code would never reach an existing database - and notify() silently
// does nothing when its template row is missing. Upsert the missing ones
// without touching subject/body, so staff edits survive.
async function ensureEmailTemplates() {
  const { DEFAULT_TEMPLATES } = await import("../src/lib/template-defs");
  for (const t of DEFAULT_TEMPLATES) {
    await prisma.emailTemplate.upsert({
      where: { code: t.code },
      create: {
        code: t.code,
        name: t.name,
        subject: t.subject,
        body: t.body,
        emailEnabled: t.emailEnabled ?? false,
      },
      update: {},
    });
  }
}

// Rows 10-11: default search configuration. Modest English stop list plus
// the British/American pairs a library catalogue actually hits. Idempotent;
// staff edits (removals show up as absent rows) are respected because these
// upserts never delete.
const DEFAULT_STOP_WORDS = [
  "a", "an", "the", "and", "or", "of", "in", "on", "for", "to",
  "with", "by", "at", "from", "as", "is", "are", "be", "its",
];
const DEFAULT_VARIANTS: [string, string][] = [
  ["catalogue", "catalog"], ["colour", "color"], ["organisation", "organization"],
  ["organise", "organize"], ["analyse", "analyze"], ["centre", "center"],
  ["defence", "defense"], ["programme", "program"], ["behaviour", "behavior"],
  ["labour", "labor"], ["grey", "gray"], ["theatre", "theater"],
];

async function ensureSearchConfig() {
  // Only seed on first run: an empty StopWord table with a marker row absent
  // cannot be told apart from "staff deleted everything", so we gate on both
  // tables being empty (the untouched state).
  const [sw, vs] = await Promise.all([prisma.stopWord.count(), prisma.variantSpelling.count()]);
  if (sw > 0 || vs > 0) return;
  await prisma.stopWord.createMany({
    data: DEFAULT_STOP_WORDS.map((word) => ({ word })),
    skipDuplicates: true,
  });
  await prisma.variantSpelling.createMany({
    data: DEFAULT_VARIANTS.map(([word, variant]) => ({ word, variant })),
    skipDuplicates: true,
  });
}

// Rows 42-43: start the registration lists from the values members already
// carry, so the form's selects reflect reality on day one. Idempotent.
async function ensureMemberRegLists() {
  const [locs, depts] = await Promise.all([
    prisma.member.findMany({
      where: { location: { not: null } },
      select: { location: true },
      distinct: ["location"],
    }),
    prisma.member.findMany({
      where: { department: { not: null } },
      select: { department: true },
      distinct: ["department"],
    }),
  ]);
  for (const l of locs) {
    if (!l.location?.trim()) continue;
    await prisma.memberLocation.upsert({
      where: { name: l.location.trim() },
      create: { name: l.location.trim() },
      update: {},
    });
  }
  for (const d of depts) {
    if (!d.department?.trim()) continue;
    await prisma.memberDepartment.upsert({
      where: { name: d.department.trim() },
      create: { name: d.department.trim() },
      update: {},
    });
  }
}

async function main() {
  // When invoked from the build (SEED_IF_EMPTY=1), only seed a fresh database
  // so redeploys never wipe existing data.
  if (process.env.SEED_IF_EMPTY === "1") {
    await ensureMemberStatuses();
    await ensureMemberRegLists();
    await ensureSearchConfig();
    await ensureEmailTemplates();
    await ensureServiceCalendar();
    await ensureBackfills();
    await ensureItemCodeLists();
    await ensureMarcTagDefs();
    // "Is this database fresh?" decides whether the build proceeds into the
    // clear-everything branch below, so ask about more than the catalogue. A
    // database mid-migration, or one whose catalogue was deliberately emptied,
    // still holds members, staff accounts and loan history that must not be
    // deleted because `Resource` happened to be at zero.
    const [resources, members, admins, loans] = await Promise.all([
      prisma.resource.count(),
      prisma.member.count(),
      prisma.adminUser.count(),
      prisma.loan.count(),
    ]);
    const existing = resources + members + admins + loans;
    if (existing > 0) {
      console.log(
        `Database already has data (resources ${resources}, members ${members}, ` +
          `staff ${admins}, loans ${loans}) — skipping seed.`,
      );
      return;
    }
  } else {
    await ensureMemberStatuses();
    await ensureMemberRegLists();
    await ensureSearchConfig();
    await ensureEmailTemplates();
    await ensureServiceCalendar();
    await ensureBackfills();
    await ensureItemCodeLists();
    await ensureMarcTagDefs();
  }

  console.log("Clearing existing data...");
  await prisma.review.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.mailQueue.deleteMany();
  await prisma.batchRun.deleteMany();
  await prisma.loan.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.copy.deleteMany();
  await prisma.member.deleteMany();
  await prisma.resource.deleteMany();
  await prisma.adminUser.deleteMany();
  await prisma.adminGroup.deleteMany();
  await prisma.loanPolicy.deleteMany();
  await prisma.emailTemplate.deleteMany();

  console.log("Seeding members...");
  const members = [];
  for (const m of MEMBERS) {
    members.push(
      await prisma.member.create({
        data: { ...m, joinedAt: new Date(Date.now() - Math.floor(200 + Math.random() * 600) * DAY) },
      }),
    );
  }

  console.log("Seeding catalogue...");
  const resources = [];
  let barcodeSeq = 1000;
  for (const r of RESOURCES) {
    const { copies, ...data } = r;
    const resource = await prisma.resource.create({
      data: {
        ...data,
        digital: r.digital ?? false,
        copies: {
          create: Array.from({ length: copies }, () => ({
            barcode: `LIB-${String(barcodeSeq++).padStart(6, "0")}`,
            location: ["Main Shelf", "Level 2", "Reference", "Reserve"][
              Math.floor(Math.random() * 4)
            ],
          })),
        },
      },
      include: { copies: true },
    });
    resources.push(resource);
  }

  console.log("Creating active and past loans...");
  // A few active physical loans (mark those copies ON_LOAN).
  const physicalResources = resources.filter((r) => r.copies.length > 0);

  const activeLoanPlan = [
    { resIdx: 0, memIdx: 0, daysAgo: 5, span: 14 }, // current, not due
    { resIdx: 4, memIdx: 1, daysAgo: 20, span: 14 }, // overdue
    { resIdx: 9, memIdx: 2, daysAgo: 3, span: 21 }, // current
    { resIdx: 13, memIdx: 6, daysAgo: 25, span: 14 }, // overdue
    { resIdx: 17, memIdx: 3, daysAgo: 2, span: 30 }, // current
  ];

  for (const p of activeLoanPlan) {
    const res = physicalResources[p.resIdx % physicalResources.length];
    const copy = res.copies.find((c) => c.status === "AVAILABLE");
    if (!copy) continue;
    const borrowedAt = new Date(Date.now() - p.daysAgo * DAY);
    const dueAt = new Date(borrowedAt.getTime() + p.span * DAY);
    await prisma.loan.create({
      data: {
        copyId: copy.id,
        resourceId: res.id,
        memberId: members[p.memIdx].id,
        borrowedAt,
        dueAt,
        status: "ACTIVE",
      },
    });
    await prisma.copy.update({ where: { id: copy.id }, data: { status: "ON_LOAN" } });
  }

  // Some returned (past) loans for history/stats.
  const pastPlan = [
    { resIdx: 1, memIdx: 0, daysAgo: 60, span: 14 },
    { resIdx: 2, memIdx: 1, daysAgo: 45, span: 14 },
    { resIdx: 5, memIdx: 4, daysAgo: 90, span: 14 },
    { resIdx: 9, memIdx: 5, daysAgo: 30, span: 14 },
    { resIdx: 16, memIdx: 7, daysAgo: 120, span: 14 },
    { resIdx: 0, memIdx: 3, daysAgo: 150, span: 14 },
  ];
  for (const p of pastPlan) {
    const res = resources[p.resIdx];
    const borrowedAt = new Date(Date.now() - p.daysAgo * DAY);
    const dueAt = new Date(borrowedAt.getTime() + p.span * DAY);
    const returnedAt = new Date(borrowedAt.getTime() + Math.floor(p.span * 0.7) * DAY);
    await prisma.loan.create({
      data: {
        copyId: res.copies[0]?.id ?? null,
        resourceId: res.id,
        memberId: members[p.memIdx].id,
        borrowedAt,
        dueAt,
        returnedAt,
        status: "RETURNED",
      },
    });
  }

  console.log("Creating reservations...");
  // Reserve a couple of titles whose copies are all out, plus one ready hold.
  await prisma.reservation.create({
    data: {
      resourceId: physicalResources[4].id,
      memberId: members[5].id,
      status: "PENDING",
    },
  });
  await prisma.reservation.create({
    data: {
      resourceId: physicalResources[13].id,
      memberId: members[0].id,
      status: "PENDING",
    },
  });
  await prisma.reservation.create({
    data: {
      resourceId: physicalResources[2].id,
      memberId: members[6].id,
      status: "READY",
      readyAt: new Date(Date.now() - 1 * DAY),
    },
  });

  console.log("Marking editor's picks...");
  await prisma.resource.updateMany({
    where: { title: { in: ["The Pragmatic Programmer", "Designing Data-Intensive Applications", "Sapiens", "Project Hail Mary"] } },
    data: { editorsPick: true },
  });

  console.log("Seeding reviews...");
  // (memberIdx, resourceIdx, rating, text?)
  const reviewPlan: [number, number, number, string?][] = [
    [0, 0, 5, "The book that made me care about craftsmanship. Still relevant."],
    [1, 0, 4, "A little dated in places but the principles hold up."],
    [2, 2, 5, "The single best systems book I've read. Dense but worth it."],
    [3, 2, 5, "Essential for anyone touching distributed systems."],
    [4, 2, 4],
    [0, 4, 5, "Sweeping and provocative. Read it with a critical eye."],
    [5, 4, 4],
    [1, 13, 5, "The world-building is unmatched. A slow burn that pays off."],
    [6, 13, 4],
    [7, 16, 5, "Changed how I plan my week. Tiny habits, big results."],
    [2, 16, 4, "Practical and readable, if a bit repetitive."],
    [4, 9, 4, "Norman's door examples will ruin doors for you forever."],
    [6, 11, 3, "Interesting science, alarmist tone."],
  ];
  for (const [mi, ri, rating, text] of reviewPlan) {
    const m = members[mi];
    const r = resources[ri];
    if (!m || !r) continue;
    await prisma.review.create({
      data: {
        memberId: m.id,
        resourceId: r.id,
        rating,
        text: text ?? null,
        createdAt: new Date(Date.now() - Math.floor(5 + Math.random() * 120) * DAY),
      },
    });
  }

  console.log("Seeding admin groups, users, policies, templates...");
  const { DEFAULT_TEMPLATES } = await import("../src/lib/template-defs");

  const AREAS = [
    "DASHBOARD", "CIRCULATION", "CATALOGUE", "MEMBERS", "LOANS",
    "RESERVATIONS", "REQUESTS", "POLICIES", "TEMPLATES", "REPORTS", "BATCH", "ADMIN",
  ];
  const groupDefs: { name: string; description: string; view: string[]; edit: string[] }[] = [
    {
      name: "Administrators",
      description: "Full access to every module including settings.",
      view: AREAS,
      edit: AREAS,
    },
    {
      name: "Librarians",
      description: "Day-to-day library operations; no system settings.",
      view: ["DASHBOARD", "CIRCULATION", "CATALOGUE", "MEMBERS", "LOANS", "RESERVATIONS", "REQUESTS", "REPORTS"],
      edit: ["CIRCULATION", "CATALOGUE", "MEMBERS", "LOANS", "RESERVATIONS", "REQUESTS"],
    },
    {
      name: "Reports Only",
      description: "Read-only access to dashboards and reports.",
      view: ["DASHBOARD", "REPORTS"],
      edit: [],
    },
  ];
  const groups: Record<string, string> = {};
  for (const g of groupDefs) {
    const created = await prisma.adminGroup.create({
      data: {
        name: g.name,
        description: g.description,
        permissions: {
          create: AREAS.map((area) => ({
            area,
            canView: g.view.includes(area) || g.edit.includes(area),
            canEdit: g.edit.includes(area),
          })),
        },
      },
    });
    groups[g.name] = created.id;
  }

  await prisma.adminUser.createMany({
    data: [
      { name: "Sarah Admin", email: "sarah.admin@example.edu", groupId: groups["Administrators"] },
      { name: "Liam Librarian", email: "liam.librarian@example.edu", groupId: groups["Librarians"] },
      { name: "Rita Reports", email: "rita.reports@example.edu", groupId: groups["Reports Only"] },
    ],
  });

  await prisma.loanPolicy.createMany({
    data: [
      { memberType: "DEFAULT", loanDays: 14, maxLoans: 5, maxRenewals: 2, renewalDays: 14, digitalDays: 14, holdPickupDays: 3 },
      { memberType: "STUDENT", loanDays: 14, maxLoans: 5, maxRenewals: 2, renewalDays: 14, digitalDays: 14, holdPickupDays: 3 },
      { memberType: "STAFF", loanDays: 30, maxLoans: 10, maxRenewals: 3, renewalDays: 30, digitalDays: 21, holdPickupDays: 5 },
      { memberType: "EXTERNAL", loanDays: 7, maxLoans: 3, maxRenewals: 1, renewalDays: 7, digitalDays: 7, holdPickupDays: 3 },
    ],
  });

  for (const t of DEFAULT_TEMPLATES) {
    await prisma.emailTemplate.create({
      data: {
        code: t.code,
        name: t.name,
        subject: t.subject,
        body: t.body,
        inAppEnabled: true,
        emailEnabled: t.emailEnabled ?? false,
      },
    });
  }

  const counts = {
    resources: await prisma.resource.count(),
    copies: await prisma.copy.count(),
    members: await prisma.member.count(),
    loans: await prisma.loan.count(),
    reservations: await prisma.reservation.count(),
    adminUsers: await prisma.adminUser.count(),
    policies: await prisma.loanPolicy.count(),
    templates: await prisma.emailTemplate.count(),
  };
  console.log("Done:", counts);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
