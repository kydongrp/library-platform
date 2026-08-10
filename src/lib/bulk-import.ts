// Server-only: parse a bulk metadata file (CSV / JSON / XML) into normalised
// rows for the catalogue. Field names are matched leniently so batches from
// different providers (Janes XML, an Excel/CSV export, a JSON dump) all work.
import { XMLParser } from "fast-xml-parser";
import { RESOURCE_TYPES, CATEGORIES } from "@/lib/constants";

export type BulkRow = {
  title: string;
  authors: string | null;
  url: string;
  year: number | null;
  venue: string | null;
  type: string | null; // normalised RESOURCE_TYPE or null (caller applies default)
  abstract: string | null;
  category: string | null; // valid category or null (caller applies default)
};

export type BulkParseResult = {
  format: "csv" | "json" | "xml" | "unknown";
  rows: BulkRow[];
  errors: string[]; // row-level problems (missing title/url), capped
};

const FIELD_ALIASES: Record<keyof BulkRow, string[]> = {
  title: ["title", "name", "headline"],
  authors: ["authors", "author", "creator", "creators", "byline", "contributor"],
  url: ["url", "link", "accessurl", "access_url", "proxiedlink", "href", "uri", "weblink"],
  year: ["year", "pubyear", "publicationyear", "published", "date", "pubdate"],
  venue: ["venue", "publication", "publicationtitle", "journal", "source", "container", "series"],
  type: ["type", "resourcetype", "contenttype", "doctype", "documenttype"],
  abstract: ["abstract", "description", "summary", "synopsis", "notes"],
  category: ["category", "domain", "subject", "topic"],
};

function normaliseKey(k: string): string {
  return k.toLowerCase().replace(/[\s_\-.]/g, "");
}

/** Map an arbitrary record object to a BulkRow using the alias table. */
function mapObject(obj: Record<string, unknown>): BulkRow {
  const byNorm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) byNorm.set(normaliseKey(k), v);

  const pick = (field: keyof BulkRow): string | null => {
    for (const alias of FIELD_ALIASES[field]) {
      const v = byNorm.get(normaliseKey(alias));
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
    return null;
  };

  const yearRaw = pick("year");
  const yearMatch = yearRaw ? yearRaw.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/) : null;

  return {
    title: pick("title") ?? "",
    authors: pick("authors"),
    url: pick("url") ?? "",
    year: yearMatch ? parseInt(yearMatch[1], 10) : null,
    venue: pick("venue"),
    type: normaliseType(pick("type")),
    abstract: pick("abstract"),
    category: normaliseCategory(pick("category")),
  };
}

function normaliseType(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.toLowerCase();
  if (t.includes("conference") || t.includes("proceeding")) return "CONFERENCE";
  if (t.includes("standard")) return "STANDARD";
  if (t.includes("magazine")) return "MAGAZINE";
  if (t.includes("audio")) return "AUDIOBOOK";
  if (t.includes("dvd") || t.includes("video")) return "DVD";
  if (t.includes("book") || t.includes("ebook") || t.includes("monograph")) return "EBOOK";
  if (t.includes("journal") || t.includes("article") || t.includes("transaction") || t.includes("periodical"))
    return "JOURNAL";
  // Exact match against our vocabulary as a fallback.
  const upper = raw.toUpperCase();
  return (RESOURCE_TYPES as readonly string[]).includes(upper) ? upper : null;
}

function normaliseCategory(raw: string | null): string | null {
  if (!raw) return null;
  const hit = (CATEGORIES as readonly string[]).find((c) => c.toLowerCase() === raw.toLowerCase());
  return hit ?? null;
}

/* ---------- CSV ---------- */

// RFC-4180-ish parser: handles quoted fields, embedded commas/newlines, "" escapes.
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, ""); // strip BOM
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\r") {
      // ignore; \n handles the row break
    } else if (ch === "\n") {
      row.push(field); field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((c) => c.trim() !== "")) rows.push(row); }
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = (cells[i] ?? "").trim()));
    return obj;
  });
}

/* ---------- XML ---------- */

function parseXml(text: string): Record<string, unknown>[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", trimValues: true });
  const doc = parser.parse(text) as Record<string, unknown>;
  // Find the first array of objects anywhere in the tree (e.g. records.record[]).
  const found = findRecordArray(doc);
  return found;
}

function findRecordArray(node: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6 || node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) {
    return node.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  }
  const obj = node as Record<string, unknown>;
  // Prefer a child whose value is an array of objects.
  for (const v of Object.values(obj)) {
    if (Array.isArray(v) && v.some((x) => x && typeof x === "object")) {
      return v.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
    }
  }
  // A single wrapped record (e.g. <records><record>…</record></records>).
  for (const v of Object.values(obj)) {
    const nested = findRecordArray(v, depth + 1);
    if (nested.length) return nested;
    if (v && typeof v === "object" && !Array.isArray(v) && looksLikeRecord(v as Record<string, unknown>)) {
      return [v as Record<string, unknown>];
    }
  }
  return [];
}

function looksLikeRecord(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj).map(normaliseKey);
  return FIELD_ALIASES.title.some((a) => keys.includes(normaliseKey(a)));
}

/* ---------- Facade ---------- */

function detectFormat(content: string, filename?: string): "csv" | "json" | "xml" | "unknown" {
  const name = (filename ?? "").toLowerCase();
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".xml")) return "xml";
  if (name.endsWith(".csv") || name.endsWith(".tsv")) return "csv";
  const t = content.trimStart();
  if (t.startsWith("<")) return "xml";
  if (t.startsWith("[") || t.startsWith("{")) return "json";
  if (t.includes(",") || t.includes("\t")) return "csv";
  return "unknown";
}

const MAX_ROWS = 1000;

export function parseBulk(content: string, filename?: string): BulkParseResult {
  const format = detectFormat(content, filename);
  let raw: Record<string, unknown>[] = [];
  const errors: string[] = [];

  try {
    if (format === "csv") raw = parseCsv(content);
    else if (format === "json") {
      const parsed = JSON.parse(content);
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as Record<string, unknown>)?.records)
          ? (parsed as { records: unknown[] }).records
          : [parsed];
      raw = arr.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
    } else if (format === "xml") raw = parseXml(content);
    else errors.push("Could not detect the file format (expected CSV, JSON, or XML).");
  } catch (e) {
    errors.push(`Failed to parse ${format.toUpperCase()}: ${e instanceof Error ? e.message : "invalid file"}.`);
    return { format, rows: [], errors };
  }

  const truncated = raw.length > MAX_ROWS;
  const rows = raw.slice(0, MAX_ROWS).map(mapObject);
  if (truncated) errors.push(`File had ${raw.length} rows; only the first ${MAX_ROWS} were read.`);

  return { format, rows, errors };
}
