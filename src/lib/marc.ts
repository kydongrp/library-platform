// MARC 21 bibliographic EXPORT — the reverse of the MARCXML import mapping in
// bulk-import.ts, so a record exported here re-imports losslessly. Two
// serialisations: MARCXML (MARC21-slim, what most ILS ingest) and binary
// ISO 2709 (.mrc, the classic exchange format).
//
// Field mapping (mirrors the importer):
//   001/003/005  control number (resource id), agency, last-transaction time
//   007          "cr" for digital resources (computer, remote)
//   008          fixed data: entered date, pub year, form, language
//   020          ISBN            040  cataloguing source
//   100/700      first / added authors (author column is "; "-joined)
//   245          title / subtitle / statement of responsibility
//   264 _1       publisher + year (RDA)         520  abstract
//   650 _4       category as an uncontrolled subject
//   856 41       access URL, with the provider in $z
//
// Pure module: no Prisma, no Node-only APIs (TextEncoder is web-standard),
// exercised directly with tsx.

import { zonedDayKey } from "@/lib/tz";

export type MarcInput = {
  id: string;
  title: string;
  subtitle: string | null;
  author: string;
  isbn: string | null;
  type: string;
  /** MONOGRAPH | SERIAL — drives leader/07 (bibliographic level). */
  materialDesignation: string;
  category: string;
  publisher: string | null;
  publishedYear: number | null;
  language: string;
  description: string | null;
  digital: boolean;
  digitalUrl: string | null;
  provider: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type DataField = { tag: string; ind1: string; ind2: string; subs: [string, string][] };
export type MarcRecord = {
  leader: string; // 24 chars; length/base-address left as zeros (filled for ISO 2709)
  controls: [string, string][]; // 001..008
  fields: DataField[];
};

const AGENCY = "DLS-ADMIN";
const SUB_MAX = 8000; // cap any one subfield; keeps ISO 2709 field lengths within 4 digits

// MARC language codes for the languages the catalogue actually uses.
const LANG_CODES: Record<string, string> = {
  english: "eng", chinese: "chi", malay: "may", tamil: "tam",
  japanese: "jpn", korean: "kor", french: "fre", german: "ger", spanish: "spa",
};

// Strip ISO 2709 structural bytes (record/field terminators, subfield
// delimiter) from data so user text can never corrupt the framing.
const clean = (v: string) => v.replace(/[\x1d\x1e\x1f]/g, " ").trim().slice(0, SUB_MAX);

function leaderFor(r: MarcInput): string {
  // 06 type of record / 07 bibliographic level. The bibliographic level comes
  // straight from the record's material designation: 's' serial, 'm' monograph.
  const t06 = r.type === "AUDIOBOOK" ? "i" : r.type === "DVD" ? "g" : "a";
  const t07 = r.materialDesignation === "SERIAL" ? "s" : "m";
  // 00000 n a m  a 22 00000  7 i  4500 — lengths patched in ISO 2709 output.
  return `00000n${t06}${t07} a2200000 i 4500`;
}

function fixed008(r: MarcInput): string {
  const d = r.createdAt;
  const entered =
    zonedDayKey(d).slice(2, 4) +
    zonedDayKey(d).slice(5, 7) +
    String(d.getUTCDate()).padStart(2, "0");
  const year = r.publishedYear ? String(r.publishedYear).padStart(4, " ").slice(0, 4) : "    ";
  const lang = LANG_CODES[r.language.toLowerCase()] ?? "und";
  const form = r.digital ? "o" : " "; // pos 23: online
  const s =
    entered + (r.publishedYear ? "s" : "n") + year + "    " + "xx " +
    "     " + form + "           " + lang + " d";
  if (s.length !== 40) throw new Error(`008 must be 40 chars, got ${s.length}`);
  return s;
}

function marc005(d: Date): string {
  // Deliberately UTC, unlike 008 above. 005 is a machine version stamp whose
  // only use is ordering, and ordering holds in any zone, so zoning it would
  // change bytes that downstream harvesters may have cached for nothing. 008
  // is a human calendar fact a cataloguer compares against the screen, so that
  // one follows the library's zone.
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.0`;
}

/** A catalogued field, as stored on the record by the MARC editor. */
export type StoredField = {
  tag: string;
  ind1: string;
  ind2: string;
  value: string | null;
  subfields: unknown;
  seq: number;
};

/**
 * Merge catalogued fields over the synthesised ones, PER TAG: if a cataloguer
 * has entered any 650, their 650s replace the derived one entirely; tags they
 * haven't touched keep the value derived from the flat columns. That keeps a
 * plain record exporting sensibly while never contradicting a real catalogue
 * entry — and it lets a repeatable tag carry as many instances as entered.
 */
function applyStoredFields(rec: MarcRecord, stored: StoredField[]): MarcRecord {
  if (stored.length === 0) return rec;

  const sorted = [...stored].sort((a, b) => a.seq - b.seq || a.tag.localeCompare(b.tag));
  const controlTags = new Set(sorted.filter((f) => /^00\d$/.test(f.tag)).map((f) => f.tag));
  const dataTags = new Set(sorted.filter((f) => !/^00\d$/.test(f.tag)).map((f) => f.tag));

  const controls: [string, string][] = rec.controls
    .filter(([tag]) => !controlTags.has(tag))
    .concat(
      sorted
        .filter((f) => /^00\d$/.test(f.tag))
        .map((f) => [f.tag, clean(String(f.value ?? ""))] as [string, string]),
    )
    .sort((a, b) => a[0].localeCompare(b[0]));

  const fields: DataField[] = rec.fields
    .filter((f) => !dataTags.has(f.tag))
    .concat(
      sorted
        .filter((f) => !/^00\d$/.test(f.tag))
        .map((f) => ({
          tag: f.tag,
          ind1: (f.ind1 || " ").slice(0, 1),
          ind2: (f.ind2 || " ").slice(0, 1),
          subs: (Array.isArray(f.subfields) ? f.subfields : [])
            .filter((s): s is { code?: unknown; value?: unknown } => !!s && typeof s === "object")
            .map((s) => [String(s.code ?? "").slice(0, 1), clean(String(s.value ?? ""))] as [string, string])
            .filter(([code, value]) => code !== "" && value !== ""),
        }))
        .filter((f) => f.subs.length > 0),
    )
    .sort((a, b) => a.tag.localeCompare(b.tag));

  return { leader: rec.leader, controls, fields };
}

export function toMarcRecord(r: MarcInput, stored: StoredField[] = []): MarcRecord {
  const authors = r.author.split(";").map((a) => clean(a)).filter(Boolean);
  const controls: [string, string][] = [
    ["001", r.id],
    ["003", AGENCY],
    ["005", marc005(r.updatedAt)],
  ];
  if (r.digital) controls.push(["007", "cr"]);
  controls.push(["008", fixed008(r)]);

  const fields: DataField[] = [];
  const f = (tag: string, ind1: string, ind2: string, ...subs: [string, string][]) =>
    fields.push({ tag, ind1, ind2, subs: subs.map(([c, v]) => [c, clean(v)] as [string, string]) });

  if (r.isbn) f("020", " ", " ", ["a", r.isbn]);
  f("040", " ", " ", ["a", AGENCY], ["b", "eng"], ["c", AGENCY]);
  if (authors.length > 0) f("100", "1", " ", ["a", authors[0]]);

  // 245 with minimal ISBD punctuation.
  const t245: [string, string][] = [
    ["a", r.title + (r.subtitle ? " :" : authors.length ? " /" : "")],
  ];
  if (r.subtitle) t245.push(["b", r.subtitle + (authors.length ? " /" : "")]);
  if (authors.length) t245.push(["c", authors.join("; ")]);
  f("245", authors.length ? "1" : "0", "0", ...t245);

  if (r.publisher || r.publishedYear) {
    const subs: [string, string][] = [];
    if (r.publisher) subs.push(["b", r.publisher + (r.publishedYear ? "," : ".")]);
    if (r.publishedYear) subs.push(["c", `${r.publishedYear}.`]);
    f("264", " ", "1", ...subs);
  }
  if (r.description) f("520", " ", " ", ["a", r.description]);
  f("650", " ", "4", ["a", r.category]);
  for (const extra of authors.slice(1)) f("700", "1", " ", ["a", extra]);
  if (r.digitalUrl) {
    const subs: [string, string][] = [["u", r.digitalUrl]];
    if (r.provider) subs.push(["z", `Access via ${r.provider}`]);
    f("856", "4", "1", ...subs);
  }

  return applyStoredFields({ leader: leaderFor(r), controls, fields }, stored);
}

/* ---------- MARCXML (MARC21-slim collection) ---------- */

const xmlEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function toMarcXml(records: MarcRecord[]): string {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<collection xmlns="http://www.loc.gov/MARC21/slim">',
  ];
  for (const rec of records) {
    out.push("  <record>");
    out.push(`    <leader>${xmlEsc(rec.leader)}</leader>`);
    for (const [tag, value] of rec.controls)
      out.push(`    <controlfield tag="${tag}">${xmlEsc(value)}</controlfield>`);
    for (const df of rec.fields) {
      out.push(`    <datafield tag="${df.tag}" ind1="${xmlEsc(df.ind1)}" ind2="${xmlEsc(df.ind2)}">`);
      for (const [code, value] of df.subs)
        out.push(`      <subfield code="${xmlEsc(code)}">${xmlEsc(value)}</subfield>`);
      out.push("    </datafield>");
    }
    out.push("  </record>");
  }
  out.push("</collection>");
  return out.join("\n");
}

/* ---------- ISO 2709 (binary .mrc) ---------- */

const FT = "\x1e"; // field terminator
const RT = "\x1d"; // record terminator
const SD = "\x1f"; // subfield delimiter

export function toMarc2709(records: MarcRecord[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const rec of records) {
    // Serialise fields in order: controls then datafields.
    const parts: { tag: string; bytes: Uint8Array }[] = [];
    for (const [tag, value] of rec.controls) parts.push({ tag, bytes: enc.encode(value + FT) });
    for (const df of rec.fields) {
      const data = df.ind1 + df.ind2 + df.subs.map(([c, v]) => SD + c + v).join("") + FT;
      parts.push({ tag: df.tag, bytes: enc.encode(data) });
    }

    let offset = 0;
    let directory = "";
    for (const p of parts) {
      if (p.bytes.length > 9999 || offset > 99999)
        throw new Error(`MARC field ${p.tag} too long for ISO 2709`);
      directory += p.tag + String(p.bytes.length).padStart(4, "0") + String(offset).padStart(5, "0");
      offset += p.bytes.length;
    }
    const dirBytes = enc.encode(directory + FT);
    const base = 24 + dirBytes.length;
    const total = base + offset + 1; // +1 record terminator
    if (total > 99999) throw new Error("MARC record too long for ISO 2709");

    const leader =
      String(total).padStart(5, "0") +
      rec.leader.slice(5, 12) +
      String(base).padStart(5, "0") +
      rec.leader.slice(17);
    if (leader.length !== 24) throw new Error("leader must be 24 chars");

    chunks.push(enc.encode(leader), dirBytes, ...parts.map((p) => p.bytes), enc.encode(RT));
  }

  const size = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(size);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
