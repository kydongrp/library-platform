// Server-only: parse a bulk metadata file (CSV / JSON / XML) into normalised
// rows for the catalogue. Field names are matched leniently so batches from
// different providers (Janes XML, an Excel/CSV export, a JSON dump) all work.
import { XMLParser } from "fast-xml-parser";
import {
  parseMarcBinary,
  looksLikeMarcBinary,
  type BinaryRecord,
} from "@/lib/marc-binary";
import { RESOURCE_TYPES } from "@/lib/constants";
import { storableMarcFields, type SourceField } from "@/lib/marc-source";

export type BulkRow = {
  title: string;
  authors: string | null;
  url: string;
  year: number | null;
  venue: string | null; // subtitle / journal-or-series name
  publisher: string | null; // bibliographic publisher (distinct from the provider tag)
  isbn: string | null;
  type: string | null; // normalised RESOURCE_TYPE or null (caller applies default)
  abstract: string | null;
  /**
   * The source record's own MARC fields, when the file was MARC.
   *
   * The columns above are a lossy reading of a record that arrived fully
   * catalogued; this carries the rest of it (subjects, notes, series,
   * classification, added entries) through to the bib. Null for CSV/JSON/XML
   * batches, which have no MARC to keep. Already trimmed by
   * storableMarcFields, and trimmed again on the server.
   */
  marc: SourceField[] | null;
};

export type BulkParseResult = {
  format: "csv" | "json" | "xml" | "marcxml" | "marc" | "unknown";
  rows: BulkRow[];
  errors: string[]; // row-level problems (missing title/url), capped
};

/**
 * The columns a CSV/JSON/XML header can name, and the header spellings that
 * mean each one. Keyed over BulkRow MINUS `marc`, which is not a column any
 * header could supply: it comes only from a MARC file, whole, and there is no
 * spelling of it to look for.
 */
type MappedColumn = Exclude<keyof BulkRow, "marc">;

const FIELD_ALIASES: Record<MappedColumn, string[]> = {
  title: ["title", "name", "headline"],
  authors: ["authors", "author", "creator", "creators", "byline", "contributor"],
  url: ["url", "link", "accessurl", "access_url", "proxiedlink", "href", "uri", "weblink"],
  year: ["year", "pubyear", "publicationyear", "published", "date", "pubdate"],
  venue: ["venue", "publication", "publicationtitle", "journal", "source", "container", "series", "subtitle"],
  publisher: ["publisher", "imprint", "publishinghouse"],
  isbn: ["isbn", "isbn13", "isbn10", "eisbn"],
  type: ["type", "resourcetype", "contenttype", "doctype", "documenttype"],
  abstract: ["abstract", "description", "summary", "synopsis", "notes"],
};

function normaliseKey(k: string): string {
  return k.toLowerCase().replace(/[\s_\-.]/g, "");
}

/**
 * Rows for one Server Action call, bounded by BYTES as well as by count.
 *
 * A row used to be nine short columns, so a hundred of them were a few tens of
 * kilobytes and a fixed row count was a perfectly good bound. Then rows started
 * carrying the source record's MARC, and the same hundred rows can be nearly
 * seven megabytes against the four-megabyte Server Action limit in
 * next.config.ts. Measured, not estimated: a hundred records of enhanced 505
 * contents notes come to 6.9 MB.
 *
 * The failure that bound prevents is not a clean error. A rejected Server
 * Action escapes the import loop as an unhandled rejection, so the progress
 * text freezes mid-count, the button stays disabled, no toast appears, and the
 * chunks already sent are already committed. The importer looks hung and the
 * catalogue is half-loaded.
 *
 * The budget is half the configured limit because the row array is not the
 * whole request: the Server Action protocol adds its own framing, and the
 * transport counts bytes where JSON.stringify counts UTF-16 code units. Half
 * is slack, not arithmetic. A single row can never exceed it on its own, since
 * marc-source.ts caps one record's MARC at 60 KB.
 */
export const CHUNK_MAX_ROWS = 100;
export const CHUNK_MAX_BYTES = 2_000_000;

export function chunkRows(
  rows: BulkRow[],
  maxRows = CHUNK_MAX_ROWS,
  maxBytes = CHUNK_MAX_BYTES,
): BulkRow[][] {
  const out: BulkRow[][] = [];
  let current: BulkRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (current.length > 0 && (current.length >= maxRows || bytes + size > maxBytes)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Map an arbitrary record object to a BulkRow using the alias table. */
function mapObject(obj: Record<string, unknown>): BulkRow {
  const byNorm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) byNorm.set(normaliseKey(k), v);

  const pick = (field: MappedColumn): string | null => {
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
    publisher: pick("publisher"),
    isbn: pick("isbn"),
    type: normaliseType(pick("type")),
    abstract: pick("abstract"),
    marc: null, // a CSV/JSON/XML batch has no source MARC to keep
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

/* ---------- CSV ---------- */

// RFC-4180-ish parser: handles quoted fields, embedded commas/newlines, "" escapes.
// Also reused by the COUNTER usage-report parser (src/lib/counter.ts).
export function parseCsv(text: string): Record<string, string>[] {
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

/* ---------- MARCXML (MARC 21 slim, e.g. Knovel eBook batches) ---------- */

// A MARCXML file is XML shaped as <collection><record><leader/><controlfield/>
// <datafield tag="…"><subfield code="…"/></datafield>…</record></collection>.
// Detected by the LC namespace or the datafield/leader element names (any NS prefix).
function looksLikeMarcXml(text: string): boolean {
  return (
    /MARC21\/slim/i.test(text) ||
    /<(?:\w+:)?leader[\s>]/i.test(text) ||
    (/<(?:\w+:)?datafield[\s>]/i.test(text) && /<(?:\w+:)?record[\s>]/i.test(text))
  );
}

type MarcSubfield = { code?: string; "#text"?: string };
type MarcDatafield = { tag?: string; ind1?: string; ind2?: string; subfield?: MarcSubfield[] };
type MarcControlfield = { tag?: string; "#text"?: string };
type MarcRecord = {
  leader?: string | { "#text"?: string };
  controlfield?: MarcControlfield[];
  datafield?: MarcDatafield[];
};

// Strip trailing ISBD punctuation (" /", " :", " ;", " ,", ".") for display.
// Done with a linear scan rather than an anchored `[…]+$` regex, which is
// quadratic (ReDoS) on a long run of matching characters. A terminal period
// that closes a single-letter initial (e.g. "Green, Don W.") is preserved.
function cleanMarc(s: string | null | undefined): string | null {
  if (s == null) return null;
  const out = String(s).slice(0, 4000).replace(/\s+/g, " ").trim();
  let end = out.length;
  while (end > 0) {
    const ch = out[end - 1];
    if (ch === " " || ch === "/" || ch === ":" || ch === ";" || ch === ",") {
      end--;
      continue;
    }
    if (ch === ".") {
      // Keep the period of a lone initial: "<space><A-Z>." at the very end.
      const prev = out[end - 2];
      const beforePrev = out[end - 3];
      if (prev && /[A-Z]/.test(prev) && (end - 2 === 0 || beforePrev === " ")) break;
      end--;
      continue;
    }
    break;
  }
  return out.slice(0, end).trim() || null;
}

function parseMarcXml(text: string): BulkRow[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    removeNSPrefix: true, // collapse <marc:record> → record
    parseTagValue: false, // keep control fields / leader as strings (leading zeros, etc.)
    parseAttributeValue: false,
    trimValues: true,
    // Control fields are exempted from that trim, and the exemption matters.
    // An 008 is exactly 40 characters addressed by offset, and its last
    // positions (language, modified record, cataloguing source) are routinely
    // spaces. Parsed with the default trim, a 40-character 008 came back as 38
    // and the record we stored was invalid MARC. stopNodes is the only hook
    // that runs before the trim rather than after it, so tagValueProcessor
    // cannot recover what has already been cut. Verified against this parser
    // build, not assumed: see scripts/test-marc-source.ts.
    stopNodes: ["*.controlfield"],
    textNodeName: "#text",
    isArray: (name) => ["record", "datafield", "subfield", "controlfield"].includes(name),
  });
  const doc = parser.parse(text) as {
    collection?: { record?: MarcRecord[] };
    record?: MarcRecord[];
  };
  const records = doc.collection?.record ?? doc.record ?? [];
  return records.map(marcRecordToRow);
}

function marcRecordToRow(rec: MarcRecord): BulkRow {
  const datafields = rec.datafield ?? [];
  const controlfields = rec.controlfield ?? [];
  const leader = (typeof rec.leader === "string" ? rec.leader : rec.leader?.["#text"]) ?? "";

  const fields = (tag: string) => datafields.filter((d) => String(d.tag) === tag);
  const first = (tag: string) => fields(tag)[0];
  const sub = (d: MarcDatafield | undefined, code: string): string | null => {
    if (!d?.subfield) return null;
    const hit = d.subfield.find((s) => String(s.code) === code);
    const v = hit?.["#text"];
    return v != null && String(v).trim() !== "" ? String(v).trim() : null;
  };
  const control = (tag: string): string => {
    const c = controlfields.find((cf) => String(cf.tag) === tag);
    return c?.["#text"] != null ? String(c["#text"]) : "";
  };

  // 245: title proper ($a) + remainder/subtitle ($b).
  const f245 = first("245");
  const title = cleanMarc(sub(f245, "a")) ?? "";
  const subtitle = cleanMarc(sub(f245, "b"));

  // Authors: main entries (100/110/111) then added entries (700/710/711).
  const names: string[] = [];
  for (const tag of ["100", "110", "111", "700", "710", "711"]) {
    for (const d of fields(tag)) {
      const a = cleanMarc(sub(d, "a"));
      if (a) names.push(a);
    }
  }
  // Inverted MARC names ("Family, Given") contain internal commas, so a comma
  // separator would blur the boundary between authors. Join with "; " instead.
  const authors = names.length ? Array.from(new Set(names)).slice(0, 6).join("; ") : null;

  // Publication: RDA 264 (ind2=1 = publication) preferred, else AACR2 260.
  const pubField =
    fields("264").find((d) => String(d.ind2) === "1") ?? first("264") ?? first("260");
  const publisher = cleanMarc(sub(pubField, "b"));
  const yearFromField = extractYear(sub(pubField, "c"));
  const yearFrom008 = extractYear(control("008").slice(7, 11));
  const year = yearFromField ?? yearFrom008;

  // 856 $u: electronic location. Prefer ind2=0 (resource) over 1 (version of).
  const f856 = fields("856");
  const pick856 =
    f856.find((d) => String(d.ind2) === "0") ?? f856.find((d) => String(d.ind2) === "1") ?? f856[0];
  const url = (sub(pick856, "u") ?? "").trim();

  // 520: summary/abstract (length-bounded to keep chunk payloads small).
  const f520 = first("520");
  const abstractRaw = f520 ? [sub(f520, "a"), sub(f520, "b")].filter(Boolean).join(" ") : "";
  const abstract = abstractRaw ? abstractRaw.slice(0, 4000) : null;

  // 020 $a: ISBN. 020 is repeatable (an e-book record usually carries both
  // the print and the electronic ISBN), so scan every 020 and prefer the
  // electronic manifestation. The "(electronic bk.)" qualifier is dropped by
  // cutting at the first "(" (no lazy `.*?` regex, which is quadratic).
  let isbn: string | null = null;
  let isbnFallback: string | null = null;
  for (const d of fields("020")) {
    const a = sub(d, "a");
    if (!a) continue;
    const clean = a.slice(0, 100).split("(")[0].replace(/[^0-9Xx-]/g, "").replace(/^-+|-+$/g, "");
    if (clean.replace(/-/g, "").length < 8) continue; // skip $z / junk
    const qualifier = (sub(d, "q") ?? a.slice(0, 100)).toLowerCase();
    if (/electronic|e-?bk|ebook|online|e-?isbn|\bpdf\b/.test(qualifier)) {
      isbn = clean;
      break;
    }
    if (!isbnFallback) isbnFallback = clean;
  }
  isbn = isbn ?? isbnFallback;

  return {
    title,
    authors,
    url,
    year,
    venue: subtitle,
    publisher,
    isbn,
    type: marcType(leader),
    abstract,
    // Everything above is a lossy reading of the record for the flat columns.
    // This keeps the record.
    marc: storableMarcFields(sourceFieldsOf(rec)).fields,
  };
}

/**
 * The incoming record's fields, in the shape marc-source.ts works in.
 *
 * Control fields first, then data fields, which is how a MARC record is
 * conventionally ordered anyway; the two readers hand us the halves separately
 * so the original interleaving is not available to preserve.
 *
 * Control values are taken RAW. Everywhere else in this file text goes through
 * cleanMarc, which collapses whitespace and strips ISBD punctuation, and doing
 * that to an 008 would destroy it: the field is a fixed 40-character string
 * addressed by offset, and roughly a third of those offsets are legitimately
 * spaces.
 */
function sourceFieldsOf(rec: MarcRecord): SourceField[] {
  const out: SourceField[] = [];
  for (const cf of rec.controlfield ?? []) {
    const tag = String(cf?.tag ?? "").trim();
    if (!tag) continue;
    out.push({ tag, ind1: " ", ind2: " ", value: String(cf["#text"] ?? ""), subfields: [] });
  }
  for (const df of rec.datafield ?? []) {
    const tag = String(df?.tag ?? "").trim();
    if (!tag) continue;
    out.push({
      tag,
      ind1: String(df.ind1 ?? " "),
      ind2: String(df.ind2 ?? " "),
      value: null,
      subfields: (df.subfield ?? []).map((s) => ({
        code: String(s?.code ?? ""),
        value: String(s?.["#text"] ?? ""),
      })),
    });
  }
  return out;
}

// Leader/06 (type of record) + /07 (bibliographic level) → our resource type.
// MARCXML batches here are digital, so textual monographs map to EBOOK.
function marcType(leader: string): string {
  const l6 = (leader[6] ?? "").toLowerCase();
  const l7 = (leader[7] ?? "").toLowerCase();
  if (l6 === "i" || l6 === "j") return "AUDIOBOOK";
  if (l6 === "g") return "DVD";
  if (l7 === "s" || l7 === "b") return "JOURNAL"; // serial / serial component
  return "EBOOK"; // textual monograph, delivered digitally
}

function extractYear(raw: string | null): number | null {
  if (!raw) return null;
  const m = raw.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return m ? parseInt(m[1], 10) : null;
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

const MAX_ROWS = 50000;

export function parseBulk(content: string, filename?: string): BulkParseResult {
  const detected = detectFormat(content, filename);
  const isMarc = detected === "xml" && looksLikeMarcXml(content);
  const format: BulkParseResult["format"] = isMarc ? "marcxml" : detected;

  let mapped: BulkRow[] = [];
  const errors: string[] = [];

  try {
    if (isMarc) {
      mapped = parseMarcXml(content);
    } else if (detected === "csv") {
      mapped = parseCsv(content).map(mapObject);
    } else if (detected === "json") {
      const parsed = JSON.parse(content);
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as Record<string, unknown>)?.records)
          ? (parsed as { records: unknown[] }).records
          : [parsed];
      mapped = arr.filter((x) => x && typeof x === "object").map((x) => mapObject(x as Record<string, unknown>));
    } else if (detected === "xml") {
      mapped = parseXml(content).map(mapObject);
    } else {
      errors.push("Could not detect the file format (expected CSV, JSON, XML, or MARCXML).");
    }
  } catch (e) {
    errors.push(`Failed to parse ${format.toUpperCase()}: ${e instanceof Error ? e.message : "invalid file"}.`);
    return { format, rows: [], errors };
  }

  if (mapped.length > MAX_ROWS) {
    errors.push(`File had ${mapped.length} rows; only the first ${MAX_ROWS} were read.`);
    mapped = mapped.slice(0, MAX_ROWS);
  }

  return { format, rows: mapped, errors };
}

/* ---------- Binary MARC21 (.mrc, ISO 2709) ---------- */

/**
 * Reshape a record from the binary reader into the XML-ish shape
 * marcRecordToRow already understands.
 *
 * An adapter rather than a second mapper: 245/100/700/264/520/856/020, the
 * inverted-name handling, the ISBD punctuation stripping and the 008 year
 * fallback are all non-obvious and already correct. Duplicating them for a
 * different container is how the two paths drift apart.
 */
function binaryRecordToXmlShape(rec: BinaryRecord): MarcRecord {
  const controlfield: MarcControlfield[] = [];
  const datafield: MarcDatafield[] = [];
  for (const f of rec.fields) {
    if (f.value !== undefined) {
      controlfield.push({ tag: f.tag, "#text": f.value });
    } else {
      datafield.push({
        tag: f.tag,
        ind1: f.ind1 ?? " ",
        ind2: f.ind2 ?? " ",
        subfield: (f.subs ?? []).map(([code, value]) => ({ code, "#text": value })),
      });
    }
  }
  return { leader: rec.leader, controlfield, datafield };
}

/**
 * Parse a binary MARC21 file (.mrc).
 *
 * Separate from parseBulk because a .mrc file cannot be handed over as a
 * string: the format stores byte offsets and frames data with control bytes, so
 * decoding it to text first shifts every offset and the records fall apart. The
 * caller reads the file as an ArrayBuffer and passes the bytes.
 */
export function parseBulkBinary(bytes: Uint8Array): BulkParseResult {
  const errors: string[] = [];

  if (!looksLikeMarcBinary(bytes)) {
    return {
      format: "unknown",
      rows: [],
      errors: [
        "This does not look like a binary MARC21 file. A .mrc file starts with a 5-digit record length; if this is MARCXML, save it as .xml or .marcxml.",
      ],
    };
  }

  const parsed = parseMarcBinary(bytes);
  errors.push(...parsed.errors);

  if (parsed.encoding !== "utf-8") {
    // Leader/09 was not "a", so the file is almost certainly MARC-8, which has
    // no TextDecoder. ASCII survives; accented and CJK characters will be
    // wrong, so say so rather than let a cataloguer discover it later.
    errors.push(
      "The file is not marked as UTF-8 (probably MARC-8). Plain text imported correctly, but accented and non-Latin characters may be wrong; check those titles after import.",
    );
  }

  let rows = parsed.records.map((r) => marcRecordToRow(binaryRecordToXmlShape(r)));

  if (rows.length > MAX_ROWS) {
    errors.push(`File had ${rows.length} records; only the first ${MAX_ROWS} were read.`);
    rows = rows.slice(0, MAX_ROWS);
  }

  return { format: "marc", rows, errors };
}
