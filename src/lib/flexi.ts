import { prisma } from "@/lib/db";
import { zonedDayRange } from "@/lib/tz";
import { isDigital } from "@/lib/availability";
import {
  MATERIAL_DESIGNATION_LABELS,
  MEMBER_TYPE_LABELS,
  RESOURCE_TYPE_LABELS,
} from "@/lib/constants";
import { FREQUENCY_LABELS, GRACE_DAYS, type Frequency } from "@/lib/serials-shared";
import {
  isoMonth,
  isoYear,
  titleCase,
  type DimensionDef,
  type MeasureDef,
} from "@/lib/flexi-core";

/**
 * The five FlexiReports cubes (SDD: "statistical reports with various
 * selected fields across modules"; Vibrant ships five preset starting points
 * including Collection Analysis). Each cube fetches a capped flat row set;
 * the pivot itself is pure and lives in flexi-core.ts.
 */

/**
 * Row ceiling per cube fetch. Statistical grouping tolerates a bounded window
 * better than an unbounded query tolerates a 500; truncation is surfaced on
 * the page, never silent.
 */
export const FLEXI_ROW_CAP = 20_000;

export type DateRange = { gte?: Date; lt?: Date };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CubeDef<R = any> = {
  key: string;
  name: string;
  description: string;
  /** What the from/to criteria filter on, e.g. "date added". */
  dateLabel: string;
  /** Counting noun for the cap note, e.g. "loans". */
  unit: string;
  dimensions: DimensionDef<R>[];
  measures: MeasureDef<R>[];
  /** Sensible first render after picking the cube. */
  defaults: { row: string; col: string | null; measure: string };
  fetch: (range: DateRange | undefined) => Promise<R[]>;
};

const DAY_MS = 86_400_000;

/* ------------------------------------------------------- 1. Collection ---- */

type CollectionRow = {
  resource: {
    id: string;
    type: string;
    digital: boolean;
    materialDesignation: string;
    category: string;
    provider: string | null;
    createdAt: Date;
  };
  copy: {
    status: string;
    location: string;
    collection: { name: string } | null;
    itemLocation: { name: string } | null;
    itemType: { name: string } | null;
  } | null;
};

const collectionCube: CubeDef<CollectionRow> = {
  key: "collection",
  name: "Collection Analysis",
  description:
    "The catalogue and its holdings: titles and copies across designations, categories, collections, locations and item types.",
  dateLabel: "date catalogued",
  unit: "holdings",
  dimensions: [
    { key: "category", label: "Category", get: (r) => r.resource.category },
    {
      key: "type",
      label: "Resource type",
      get: (r) => RESOURCE_TYPE_LABELS[r.resource.type] ?? r.resource.type,
    },
    {
      key: "designation",
      label: "Designation",
      get: (r) =>
        MATERIAL_DESIGNATION_LABELS[r.resource.materialDesignation] ??
        r.resource.materialDesignation,
    },
    { key: "source", label: "Source", get: (r) => r.resource.provider ?? "Local collection" },
    {
      key: "format",
      label: "Format",
      // The canonical digital rule, not "has no copies": a weeded physical
      // book has zero copies but is still a physical title.
      get: (r) => (isDigital(r.resource) ? "Digital" : "Physical"),
    },
    { key: "collection", label: "Collection", get: (r) => r.copy?.collection?.name },
    {
      key: "location",
      label: "Location",
      // Legacy free-text shelf backs up the managed code list.
      get: (r) => r.copy?.itemLocation?.name ?? r.copy?.location,
    },
    { key: "itemType", label: "Item type", get: (r) => r.copy?.itemType?.name },
    { key: "copyStatus", label: "Copy status", get: (r) => titleCase(r.copy?.status) },
    { key: "addedYear", label: "Year added", get: (r) => isoYear(r.resource.createdAt), temporal: true },
    { key: "addedMonth", label: "Month added", get: (r) => isoMonth(r.resource.createdAt), temporal: true },
  ],
  measures: [
    { key: "titles", label: "Titles", kind: "distinct", of: (r) => r.resource.id, format: "int" },
    { key: "copies", label: "Copies", kind: "sum", of: (r) => (r.copy ? 1 : 0), format: "int" },
    {
      key: "available",
      label: "Available copies",
      kind: "sum",
      of: (r) => (r.copy?.status === "AVAILABLE" ? 1 : 0),
      format: "int",
    },
  ],
  defaults: { row: "category", col: "format", measure: "titles" },
  fetch: async (range) => {
    const resources = await prisma.resource.findMany({
      where: range ? { createdAt: range } : undefined,
      select: {
        id: true,
        type: true,
        digital: true,
        materialDesignation: true,
        category: true,
        provider: true,
        createdAt: true,
        copies: {
          select: {
            status: true,
            location: true,
            collection: { select: { name: true } },
            itemLocation: { select: { name: true } },
            itemType: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: FLEXI_ROW_CAP,
    });
    // One row per holding: each copy, or the bare title when digital-only.
    // The cap cuts at whole titles, never mid-title, so a title's copy count
    // is either fully in the window or fully out of it.
    const rows: CollectionRow[] = [];
    for (const { copies, ...resource } of resources) {
      const need = Math.max(copies.length, 1);
      if (rows.length + need > FLEXI_ROW_CAP && rows.length > 0) break;
      if (copies.length === 0) rows.push({ resource, copy: null });
      else for (const copy of copies) rows.push({ resource, copy });
    }
    return rows;
  },
};

/* ------------------------------------------------------ 2. Circulation ---- */

type CirculationRow = {
  memberId: string;
  resourceId: string;
  copyId: string | null;
  borrowedAt: Date;
  status: string;
  returnStatus: string | null;
  returnCondition: string | null;
  renewals: number;
  fineCents: number;
  member: { memberType: string; status: string };
  resource: { type: string; category: string; materialDesignation: string };
  copy: { itemType: { name: string } | null } | null;
};

const circulationCube: CubeDef<CirculationRow> = {
  key: "circulation",
  name: "Circulation Analysis",
  description:
    "Loan activity: who borrows what, when, how it comes back, and the fines it generates.",
  dateLabel: "borrow date",
  unit: "loans",
  dimensions: [
    { key: "borrowedMonth", label: "Month borrowed", get: (r) => isoMonth(r.borrowedAt), temporal: true },
    { key: "borrowedYear", label: "Year borrowed", get: (r) => isoYear(r.borrowedAt), temporal: true },
    {
      key: "memberType",
      label: "Member type",
      get: (r) => MEMBER_TYPE_LABELS[r.member.memberType] ?? r.member.memberType,
    },
    { key: "memberStatus", label: "Member status", get: (r) => r.member.status },
    {
      key: "resourceType",
      label: "Resource type",
      get: (r) => RESOURCE_TYPE_LABELS[r.resource.type] ?? r.resource.type,
    },
    { key: "category", label: "Category", get: (r) => r.resource.category },
    {
      key: "designation",
      label: "Designation",
      get: (r) =>
        MATERIAL_DESIGNATION_LABELS[r.resource.materialDesignation] ??
        r.resource.materialDesignation,
    },
    { key: "format", label: "Format", get: (r) => (r.copyId ? "Physical" : "Digital") },
    { key: "loanStatus", label: "Loan status", get: (r) => titleCase(r.status) },
    {
      key: "returnStatus",
      label: "Return timeliness",
      get: (r) => (r.returnStatus === "ON_TIME" ? "On time" : titleCase(r.returnStatus)),
    },
    { key: "condition", label: "Return condition", get: (r) => titleCase(r.returnCondition) },
    { key: "itemType", label: "Item type", get: (r) => r.copy?.itemType?.name },
  ],
  measures: [
    { key: "loans", label: "Loans", kind: "count", format: "int" },
    { key: "borrowers", label: "Borrowers", kind: "distinct", of: (r) => r.memberId, format: "int" },
    { key: "titles", label: "Titles borrowed", kind: "distinct", of: (r) => r.resourceId, format: "int" },
    { key: "fines", label: "Fines assessed", kind: "sum", of: (r) => r.fineCents, format: "money" },
    { key: "renewals", label: "Renewals", kind: "sum", of: (r) => r.renewals, format: "int" },
  ],
  defaults: { row: "borrowedMonth", col: "memberType", measure: "loans" },
  fetch: (range) =>
    prisma.loan.findMany({
      where: range ? { borrowedAt: range } : undefined,
      select: {
        memberId: true,
        resourceId: true,
        copyId: true,
        borrowedAt: true,
        status: true,
        returnStatus: true,
        returnCondition: true,
        renewals: true,
        fineCents: true,
        member: { select: { memberType: true, status: true } },
        resource: { select: { type: true, category: true, materialDesignation: true } },
        copy: { select: { itemType: { select: { name: true } } } },
      },
      orderBy: { borrowedAt: "desc" },
      take: FLEXI_ROW_CAP,
    }),
};

/* -------------------------------------------------------- 3. Members ---- */

type MemberRow = {
  memberType: string;
  status: string;
  language: string;
  location: string | null;
  department: string | null;
  joinedAt: Date;
  _count: { loans: number; reservations: number };
};

const membersCube: CubeDef<MemberRow> = {
  key: "members",
  name: "Membership Analysis",
  description:
    "The member file: types, statuses, languages, locations and departments, with lifetime borrowing.",
  dateLabel: "date joined",
  unit: "members",
  dimensions: [
    {
      key: "memberType",
      label: "Member type",
      get: (r) => MEMBER_TYPE_LABELS[r.memberType] ?? r.memberType,
    },
    { key: "status", label: "Member status", get: (r) => r.status },
    { key: "language", label: "Language", get: (r) => r.language },
    { key: "location", label: "Location", get: (r) => r.location },
    { key: "department", label: "Department", get: (r) => r.department },
    { key: "joinedYear", label: "Year joined", get: (r) => isoYear(r.joinedAt), temporal: true },
    { key: "joinedMonth", label: "Month joined", get: (r) => isoMonth(r.joinedAt), temporal: true },
  ],
  measures: [
    { key: "members", label: "Members", kind: "count", format: "int" },
    { key: "loans", label: "Loans, lifetime", kind: "sum", of: (r) => r._count.loans, format: "int" },
    {
      key: "reservations",
      label: "Reservations, lifetime",
      kind: "sum",
      of: (r) => r._count.reservations,
      format: "int",
    },
  ],
  defaults: { row: "memberType", col: "status", measure: "members" },
  fetch: (range) =>
    prisma.member.findMany({
      where: range ? { joinedAt: range } : undefined,
      select: {
        memberType: true,
        status: true,
        language: true,
        location: true,
        department: true,
        joinedAt: true,
        _count: { select: { loans: true, reservations: true } },
      },
      orderBy: { joinedAt: "desc" },
      take: FLEXI_ROW_CAP,
    }),
};

/* --------------------------------------------------- 4. Acquisitions ---- */

type AcqRow = {
  poId: string;
  qty: number;
  unitCents: number;
  receivedQty: number;
  po: {
    status: string;
    orderedAt: Date;
    supplier: { name: string };
    fund: { fiscalYear: string; name: string };
  };
};

const acquisitionsCube: CubeDef<AcqRow> = {
  key: "acquisitions",
  name: "Acquisitions Analysis",
  description:
    "Purchase order lines: spend and quantities across funds, suppliers and fiscal years.",
  dateLabel: "order date",
  unit: "order lines",
  dimensions: [
    { key: "fiscalYear", label: "Fiscal year", get: (r) => r.po.fund.fiscalYear, temporal: true },
    { key: "fund", label: "Fund", get: (r) => r.po.fund.name },
    { key: "supplier", label: "Supplier", get: (r) => r.po.supplier.name },
    { key: "status", label: "Order status", get: (r) => titleCase(r.po.status) },
    { key: "orderedMonth", label: "Month ordered", get: (r) => isoMonth(r.po.orderedAt), temporal: true },
    { key: "orderedYear", label: "Year ordered", get: (r) => isoYear(r.po.orderedAt), temporal: true },
  ],
  measures: [
    {
      key: "value",
      label: "Order value",
      kind: "sum",
      of: (r) => r.qty * r.unitCents,
      format: "money",
    },
    { key: "lines", label: "Order lines", kind: "count", format: "int" },
    { key: "orders", label: "Orders", kind: "distinct", of: (r) => r.poId, format: "int" },
    { key: "qtyOrdered", label: "Quantity ordered", kind: "sum", of: (r) => r.qty, format: "int" },
    { key: "qtyReceived", label: "Quantity received", kind: "sum", of: (r) => r.receivedQty, format: "int" },
  ],
  defaults: { row: "fund", col: "status", measure: "value" },
  fetch: (range) =>
    prisma.poLine.findMany({
      where: range ? { po: { orderedAt: range } } : undefined,
      select: {
        poId: true,
        qty: true,
        unitCents: true,
        receivedQty: true,
        po: {
          select: {
            status: true,
            orderedAt: true,
            supplier: { select: { name: true } },
            fund: { select: { fiscalYear: true, name: true } },
          },
        },
      },
      orderBy: { po: { orderedAt: "desc" } },
      take: FLEXI_ROW_CAP,
    }),
};

/* -------------------------------------------------------- 5. Serials ---- */

type SerialRow = {
  serialId: string;
  status: string;
  expectedAt: Date;
  receivedAt: Date | null;
  claimedAt: Date | null;
  serial: {
    frequency: string;
    status: string;
    resource: { title: string };
  };
};

function issueTimeliness(r: SerialRow, now: Date): string {
  const graceEnd = r.expectedAt.getTime() + GRACE_DAYS * DAY_MS;
  if (r.status === "RECEIVED")
    return r.receivedAt && r.receivedAt.getTime() > graceEnd ? "Arrived late" : "On time";
  if (r.status === "EXPECTED") return now.getTime() > graceEnd ? "Late" : "Not yet due";
  return "Skipped";
}

const serialsCube: CubeDef<SerialRow> = {
  key: "serials",
  name: "Serials Analysis",
  description:
    "Issue-level arrivals: what each subscription delivered, on time or late, and what was claimed.",
  dateLabel: "expected date",
  unit: "issues",
  dimensions: [
    { key: "title", label: "Serial title", get: (r) => r.serial.resource.title },
    {
      key: "frequency",
      label: "Publication pattern",
      get: (r) => FREQUENCY_LABELS[r.serial.frequency as Frequency] ?? r.serial.frequency,
    },
    { key: "serialStatus", label: "Subscription status", get: (r) => titleCase(r.serial.status) },
    { key: "issueStatus", label: "Issue status", get: (r) => titleCase(r.status) },
    {
      key: "timeliness",
      label: "Timeliness",
      get: (r) => issueTimeliness(r, new Date()),
    },
    { key: "claimed", label: "Claimed", get: (r) => (r.claimedAt ? "Claimed" : "Not claimed") },
    { key: "expectedMonth", label: "Month expected", get: (r) => isoMonth(r.expectedAt), temporal: true },
    { key: "expectedYear", label: "Year expected", get: (r) => isoYear(r.expectedAt), temporal: true },
  ],
  measures: [
    { key: "issues", label: "Issues", kind: "count", format: "int" },
    {
      key: "received",
      label: "Received",
      kind: "sum",
      of: (r) => (r.status === "RECEIVED" ? 1 : 0),
      format: "int",
    },
    {
      key: "outstanding",
      label: "Still expected",
      kind: "sum",
      of: (r) => (r.status === "EXPECTED" ? 1 : 0),
      format: "int",
    },
    { key: "claims", label: "Claims sent", kind: "sum", of: (r) => (r.claimedAt ? 1 : 0), format: "int" },
    { key: "titles", label: "Serials", kind: "distinct", of: (r) => r.serialId, format: "int" },
  ],
  defaults: { row: "title", col: "issueStatus", measure: "issues" },
  fetch: (range) =>
    prisma.serialIssue.findMany({
      where: range ? { expectedAt: range } : undefined,
      select: {
        serialId: true,
        status: true,
        expectedAt: true,
        receivedAt: true,
        claimedAt: true,
        serial: {
          select: {
            frequency: true,
            status: true,
            resource: { select: { title: true } },
          },
        },
      },
      orderBy: { expectedAt: "desc" },
      take: FLEXI_ROW_CAP,
    }),
};

/* ----------------------------------------------------------- registry ---- */

export const CUBES: CubeDef[] = [
  collectionCube,
  circulationCube,
  membersCube,
  acquisitionsCube,
  serialsCube,
];

export function getCube(key: string | undefined): CubeDef | undefined {
  return CUBES.find((c) => c.key === key);
}

/**
 * Parse the from/to criteria into a prisma date range. `to` is inclusive.
 * Each bound is validated on its own: an unparseable `from` must not silently
 * discard a valid `to` (or vice versa) and widen the query to everything.
 */
export function parseRange(from?: string, to?: string): DateRange | undefined {
  // Bounds are the start of the named day in the library's zone, not UTC
  // midnight, which is 08:00 there. zonedDayRange drops a bound it cannot
  // parse, which preserves the property this function was written for: a bad
  // `from` must not discard a good `to` and widen the query to everything.
  const { gte, lt } = zonedDayRange(from, to);
  if (!gte && !lt) return undefined;
  return { ...(gte && { gte }), ...(lt && { lt }) };
}
