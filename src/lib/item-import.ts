// Bulk items import (SDD Items module, comparison row 36: "importing item
// records in XML format"; CSV and JSON accepted too, like the other
// importers). Pure (no prisma) so it's tsx-testable; the items action
// resolves bibs/codes and does the writes.

import { XMLParser } from "fast-xml-parser";
import { parseCsv } from "@/lib/bulk-import";

export type ItemRow = {
  line: number; // 1-based data-row number, for error reporting
  barcode: string;
  // Bib match: any one of these identifies the record the copy belongs to.
  isbn: string | null;
  title: string | null;
  resourceId: string | null;
  // Optional code-list assignments, matched by code (e.g. "REF").
  collectionCode: string | null;
  locationCode: string | null;
  itemTypeCode: string | null;
  status: string;
};

export type ItemParseResult = {
  rows: ItemRow[];
  skipped: { line: number; reason: string }[];
  warnings: string[];
};

export const ITEM_IMPORT_MAX_ROWS = 5_000;

/**
 * Importable statuses. Circulation states (ON_LOAN, RESERVED) are refused:
 * they assert a loan or hold that has no backing row, and would wedge the
 * copy: checkout and reservation are the only writers of those states.
 */
export const IMPORTABLE_STATUSES = ["AVAILABLE", "MAINTENANCE", "LOST"] as const;

const ALIASES: Record<string, string[]> = {
  barcode: ["barcode", "bar code", "item barcode", "itemid", "item id", "accession", "accession no", "accession number"],
  isbn: ["isbn", "isbn13", "isbn-13", "isbn10", "isbn-10"],
  title: ["title", "bib title", "resource title", "work"],
  resourceId: ["resourceid", "resource id", "bibid", "bib id", "record id", "recordid"],
  collectionCode: ["collection", "collection code", "coll", "colln"],
  locationCode: ["location", "location code", "loc", "shelf", "shelving location", "sublocation"],
  itemTypeCode: ["itemtype", "item type", "type", "material type", "mattype"],
  status: ["status", "item status", "state"],
};

const normKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

const LOOKUP = new Map<string, string>();
for (const [field, aliases] of Object.entries(ALIASES))
  for (const a of aliases) LOOKUP.set(normKey(a), field);

/** Strip ISBN punctuation so 978-0-13-468599-1 matches 9780134685991. */
export function normaliseIsbn(raw: string): string {
  return raw.replace(/[^0-9Xx]/g, "").toUpperCase();
}

function toRecord(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const field = LOOKUP.get(normKey(k));
    if (!field) continue;
    // XML leaves may parse as objects with a #text node.
    const val =
      v == null
        ? ""
        : typeof v === "object"
          ? String((v as Record<string, unknown>)["#text"] ?? "")
          : String(v);
    if (val.trim()) out[field] = val.trim();
  }
  return out;
}

function parseXmlItems(text: string): Record<string, string>[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    trimValues: true,
    removeNSPrefix: true,
    parseTagValue: false,
  });
  let doc: unknown;
  try {
    doc = parser.parse(text);
  } catch {
    return [];
  }
  return findItemArray(doc).map(toRecord);
}

/** First array of objects that look like item rows, anywhere in the tree. */
function findItemArray(node: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6 || node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) {
    const objs = node.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
    if (objs.some(looksLikeItem)) return objs;
    return [];
  }
  const obj = node as Record<string, unknown>;
  if (looksLikeItem(obj) && depth > 0) return [obj];
  for (const v of Object.values(obj)) {
    const nested = findItemArray(v, depth + 1);
    if (nested.length) return nested;
  }
  return [];
}

function looksLikeItem(obj: unknown): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const keys = Object.keys(obj as Record<string, unknown>).map(normKey);
  return ALIASES.barcode.some((a) => keys.includes(normKey(a)));
}

function parseJsonItems(text: string): Record<string, string>[] {
  try {
    const doc = JSON.parse(text) as unknown;
    let arr: unknown[] | undefined;
    if (Array.isArray(doc)) arr = doc;
    else if (typeof doc === "object" && doc !== null) {
      arr = Object.values(doc).find((v) => Array.isArray(v)) as unknown[] | undefined;
      // A single bare record ({"barcode": ..., "isbn": ...}) is valid input.
      if (!arr && looksLikeItem(doc)) arr = [doc];
    }
    if (!arr) return [];
    return arr.filter((x): x is Record<string, unknown> => !!x && typeof x === "object").map(toRecord);
  } catch {
    return [];
  }
}

/**
 * Tab-separated rows (an Excel paste is TSV). No quoting dialect: Excel
 * doesn't quote TSV fields, so a plain split per line is the correct parse.
 */
function parseTsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split("\t").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => (obj[h] = (cells[i] ?? "").trim()));
    return toRecord(obj);
  });
}

function detectFormat(text: string, filename?: string): "xml" | "json" | "csv" {
  const ext = filename?.toLowerCase().split(".").pop();
  if (ext === "xml") return "xml";
  if (ext === "json") return "json";
  if (ext === "csv" || ext === "txt" || ext === "tsv") return "csv";
  const head = text.trimStart().slice(0, 200);
  if (head.startsWith("<")) return "xml";
  if (head.startsWith("{") || head.startsWith("[")) return "json";
  return "csv";
}

const clip = (v: string | undefined, n: number) => (v ?? "").trim().slice(0, n);

export function parseItemRows(text: string, filename?: string): ItemParseResult {
  const warnings: string[] = [];
  const format = detectFormat(text, filename);

  // Records keep their positions here: all-blank rows are reported as
  // skipped below, never silently dropped (which would also shift the line
  // numbers of every later error).
  let records: Record<string, string>[];
  const body = text.slice(0, 8_000_000);
  if (format === "xml") records = parseXmlItems(body);
  else if (format === "json") records = parseJsonItems(body);
  else {
    // An Excel paste is tab-separated; a .csv upload is comma-separated.
    const firstLine = body.trimStart().split(/\r?\n/, 1)[0] ?? "";
    records = firstLine.includes("\t") ? parseTsv(body) : parseCsv(body).map(toRecord);
  }

  if (records.length === 0) {
    return {
      rows: [],
      skipped: [],
      warnings: [
        `No item rows found in the ${format.toUpperCase()}. Every record needs at least a barcode, plus an ISBN, title or record id to say which bib it belongs to.`,
      ],
    };
  }
  if (records.length > ITEM_IMPORT_MAX_ROWS) {
    warnings.push(
      `File has ${records.length.toLocaleString()} rows; only the first ${ITEM_IMPORT_MAX_ROWS.toLocaleString()} were read. Import the rest in a second batch.`,
    );
    records = records.slice(0, ITEM_IMPORT_MAX_ROWS);
  }

  const rows: ItemRow[] = [];
  const skipped: { line: number; reason: string }[] = [];
  const seen = new Set<string>();

  records.forEach((r, i) => {
    const line = i + 1;
    if (Object.keys(r).length === 0) {
      skipped.push({ line, reason: "no recognised fields on this row" });
      return;
    }
    const barcode = clip(r.barcode, 64).toUpperCase();
    if (!barcode) {
      skipped.push({ line, reason: "no barcode" });
      return;
    }
    if (seen.has(barcode)) {
      skipped.push({ line, reason: `duplicate barcode ${barcode} within the file` });
      return;
    }
    const isbn = r.isbn ? normaliseIsbn(r.isbn) : null;
    const title = clip(r.title, 300) || null;
    const resourceId = clip(r.resourceId, 40) || null;
    if (!isbn && !title && !resourceId) {
      skipped.push({ line, reason: `${barcode}: no ISBN, title or record id to match a bib` });
      return;
    }
    const status = clip(r.status, 20).toUpperCase().replace(/\s+/g, "_") || "AVAILABLE";
    if (!(IMPORTABLE_STATUSES as readonly string[]).includes(status)) {
      skipped.push({
        line,
        reason: `${barcode}: status "${r.status}" is not importable (allowed: ${IMPORTABLE_STATUSES.join(", ")})`,
      });
      return;
    }
    seen.add(barcode);
    rows.push({
      line,
      barcode,
      isbn: isbn || null,
      title,
      resourceId,
      collectionCode: clip(r.collectionCode, 24).toUpperCase().replace(/\s+/g, "_") || null,
      locationCode: clip(r.locationCode, 24).toUpperCase().replace(/\s+/g, "_") || null,
      itemTypeCode: clip(r.itemTypeCode, 24).toUpperCase().replace(/\s+/g, "_") || null,
      status,
    });
  });

  return { rows, skipped, warnings };
}
