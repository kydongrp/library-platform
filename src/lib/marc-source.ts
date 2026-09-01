/**
 * What of an INCOMING MARC record we keep on the bib we create from it.
 *
 * The importer used to read a vendor record only to fill the flat columns
 * (title, author, publisher, year, ISBN, URL) and then drop the record on the
 * floor. Everything a cataloguer had done upstream (subjects, notes, series,
 * classification, added entries) was thrown away at the door, and the record
 * detail screen said "No catalogued fields yet" about a record that had arrived
 * fully catalogued. This module is the rule for keeping it.
 *
 * WHAT IS DROPPED, AND WHY EXACTLY THREE TAGS:
 *
 *   001  control number     the exporting agency's identifier for the record
 *   003  its agency code
 *   005  its last-transaction stamp
 *
 * These three describe the RECORD's identity at the agency that sent it, not
 * the work. We regenerate all three on export (src/lib/marc.ts: 001 is our
 * resource id, 003 is DLS-ADMIN, 005 is our updatedAt). Keeping the incoming
 * ones would make an exported record assert that a foreign control number is a
 * DLS-ADMIN control number, which is false and would collide in any system that
 * harvests on 001+003.
 *
 * The incoming number is not lost: MARC 21 has a field for exactly this case.
 * 035 $a carries a system control number qualified by its source agency, in the
 * form (agency)number, so the record still says where it came from and a
 * duplicate check against the source system still works. That is what an
 * importing agency is supposed to do with someone else's 001, and it is what
 * migrateSourceControlNumber below does.
 *
 * EVERYTHING ELSE IS KEPT, including 007 and 008. Those are bibliographic
 * description, not record identity, and the vendor's 008 is invariably better
 * than the one we synthesise from four flat columns.
 *
 * Pure: no database, no network, no clock. It has to be, because the import
 * file is parsed in the BROWSER (see src/app/admin/catalogue/import/widgets.tsx)
 * and this trims the payload before it crosses the wire. The server applies the
 * same rule again on arrival, because a bounded payload that the client
 * promised is not a bounded payload.
 */

export type SourceSubfield = { code: string; value: string };

/** One field of an incoming record, normalised across the XML and binary readers. */
export type SourceField = {
  tag: string;
  ind1: string;
  ind2: string;
  /** Control fields (00X) carry a value; data fields carry subfields. */
  value: string | null;
  subfields: SourceSubfield[];
};

/** Tags we regenerate ourselves on export, so an incoming one must not survive. */
export const REGENERATED_TAGS = ["001", "003", "005"];

/**
 * Whether a tag is in the MARC 21 local-use block, which we do not import.
 *
 * 9XX is reserved for local definition, and this catalogue has defined it: the
 * five DSTA tags (StandardNo, StandardsforITT, ChapterName, DomainCode and
 * POC) live there, and the curation pages and the public feed read them. That
 * is precisely why a vendor's 9XX cannot be let in. "Local" means local to
 * whoever wrote the record, so a supplier's 951 means something in the
 * supplier's system and nothing in ours; accepting it files foreign data under
 * our own labels, where every consumer will read it as ours.
 *
 * It is also the one block where that mistake carries personal data. Our 954
 * is Point of Contact: a name, an email address and a department. A vendor
 * record carrying its own 954 would have appeared on the record screen, in
 * every catalogue export, and on the unauthenticated feed, as a DLS point of
 * contact. Nothing downstream filters 9XX, because until now nothing could put
 * anything there but us.
 */
export function isLocalUseTag(tag: string): boolean {
  return /^9\d\d$/.test(tag);
}

/**
 * Bounds. Not one of these bites on a real bibliographic record; they exist so
 * that a malformed or hostile file cannot turn an import into an outage.
 *
 * The two byte limits are byte limits and not character limits on purpose.
 * ISO 2709 (the .mrc serialisation in src/lib/marc.ts) stores a field's length
 * in four digits and a record's in five, so both ceilings are counted in bytes
 * on the wire. A 4,000-character CJK note is 12,000 bytes, which would sail
 * past a character cap and then throw at export time, on a different day, to a
 * different person, with no clue pointing back here.
 */
export const MAX_FIELDS_PER_RECORD = 200;
export const MAX_FIELD_BYTES = 9_000; // under the 9999 an ISO 2709 directory entry can express
export const MAX_RECORD_BYTES = 60_000; // leaves room for our derived fields under the 99999 cap

export type StorableMarc = {
  fields: SourceField[];
  /** Fields whose text was cut to fit MAX_FIELD_BYTES. */
  truncated: number;
  /** Fields dropped whole, because the record ran past its budget. */
  dropped: number;
};

const encoder = new TextEncoder();

function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/**
 * Cut a string to a byte budget without splitting a UTF-8 character.
 *
 * Slicing by character count and hoping is how a truncation ends up one byte
 * over, or ends in half a code point that the database then rejects.
 */
function truncateToBytes(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(s.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

/**
 * Strip the three ISO 2709 framing bytes out of data.
 *
 * A subfield delimiter sitting inside a subfield's text would re-frame the
 * record when it is serialised, so an incoming record carrying one (whether by
 * accident or design) must not be able to smuggle it through us.
 */
function stripFraming(s: string): string {
  return s.replace(/[\u001d\u001e\u001f]/g, " ");
}

/**
 * Clean a CONTROL field's value: framing bytes out, length capped, NO TRIM.
 *
 * The single definition of this rule, imported by everything that writes or
 * reads a control value (the importer here, the MARC editor in
 * src/app/actions/marc.ts, the exporter in src/lib/marc.ts). It lives in one
 * place because the same mistake has now been made in each of them
 * independently: 008 is a fixed 40-character string addressed by offset, its
 * last positions are routinely spaces, and `.trim()` is such an obvious thing
 * to reach for that three separate helpers reached for it. A trimmed 008 is 38
 * characters and every offset past the cut is a lie.
 */
export function cleanControlValue(value: string, maxChars: number): string {
  return stripFraming(String(value ?? "")).slice(0, maxChars);
}

/** Serialised size of a field, matching how toMarc2709 lays one out. */
function fieldBytes(f: SourceField): number {
  if (f.value !== null) return byteLength(f.value) + 1; // value + field terminator
  const subs = f.subfields.reduce((n, s) => n + 2 + byteLength(s.value), 0); // delimiter + code + value
  return 2 + subs + 1; // indicators + subfields + field terminator
}

/** A tag is well formed if it is exactly three digits. */
function isTag(tag: string): boolean {
  return /^\d{3}$/.test(tag);
}

function isControlTag(tag: string): boolean {
  return /^00\d$/.test(tag);
}

/**
 * Turn the source 001 (+003) into an 035, the way an importing agency should.
 *
 * Returns null when there is nothing to carry over, or when an 035 already
 * holds the same number: vendors often supply their own, and re-importing the
 * same file must not stack up duplicates. That is also what makes the whole
 * pipeline safe to run twice, since a second pass sees no 001 at all.
 */
export function migrateSourceControlNumber(fields: SourceField[]): SourceField | null {
  const f001 = fields.find((f) => f.tag === "001" && f.value);
  if (!f001?.value) return null;
  const number = stripFraming(f001.value).trim();
  if (!number) return null;

  const agency = stripFraming(fields.find((f) => f.tag === "003")?.value ?? "").trim();
  const qualified = agency ? `(${agency})${number}` : number;

  const already = fields.some(
    (f) =>
      f.tag === "035" &&
      f.subfields.some((s) => {
        const v = s.value.trim();
        // Match on the qualified form and on the bare number, because a vendor
        // that supplies both an 001 and an 035 does not always qualify the 035.
        return v === qualified || v === number;
      }),
  );
  if (already) return null;

  return { tag: "035", ind1: " ", ind2: " ", value: null, subfields: [{ code: "a", value: qualified }] };
}

/**
 * The fields of an incoming record that we store on the bib we create.
 *
 * IDEMPOTENT, and it has to be: the browser applies it to trim the payload and
 * the server applies it again to the payload it received. Running it on its own
 * output must return that output unchanged, which holds because the tags it
 * drops are gone by then and the 035 it adds suppresses itself.
 */
export function storableMarcFields(raw: SourceField[]): StorableMarc {
  const source = Array.isArray(raw) ? raw : [];
  const carried = migrateSourceControlNumber(source);

  const kept: SourceField[] = [];
  let truncated = 0;
  let dropped = 0;
  let budget = MAX_RECORD_BYTES;

  const consider = (f: SourceField): void => {
    if (kept.length >= MAX_FIELDS_PER_RECORD) {
      dropped++;
      return;
    }
    if (fieldBytes(f) > MAX_FIELD_BYTES) {
      // Cut the text rather than drop the field. A 505 contents note that runs
      // long is still worth most of its value truncated; gone entirely it is
      // worth none, and the cataloguer has no sign it ever existed.
      const room = Math.max(0, MAX_FIELD_BYTES - (f.value !== null ? 1 : 2 + 1));
      if (f.value !== null) {
        f = { ...f, value: truncateToBytes(f.value, room) };
      } else {
        let left = room;
        const subs: SourceSubfield[] = [];
        for (const s of f.subfields) {
          const cost = 2 + byteLength(s.value);
          if (left < 3) break;
          if (cost <= left) {
            subs.push(s);
            left -= cost;
          } else {
            subs.push({ code: s.code, value: truncateToBytes(s.value, left - 2) });
            left = 0;
          }
        }
        f = { ...f, subfields: subs };
      }
      truncated++;
    }
    const size = fieldBytes(f);
    if (size > budget) {
      dropped++;
      return;
    }
    budget -= size;
    kept.push(f);
  };

  for (const f of source) {
    if (!f || typeof f !== "object") continue;
    const tag = String(f.tag ?? "").trim();
    if (!isTag(tag)) continue;
    if (REGENERATED_TAGS.includes(tag)) continue;
    if (isLocalUseTag(tag)) continue;

    if (isControlTag(tag)) {
      // cleanControlValue, not the data-field cleaner: no trim. 008 is a
      // fixed 40-character string in which position 0 and position 39 are as
      // meaningful as any other, and both are routinely spaces.
      const value = cleanControlValue(String(f.value ?? ""), MAX_FIELD_BYTES);
      if (!value) continue;
      consider({ tag, ind1: " ", ind2: " ", value, subfields: [] });
      continue;
    }

    const subfields = (Array.isArray(f.subfields) ? f.subfields : [])
      .filter((s): s is SourceSubfield => !!s && typeof s === "object")
      .map((s) => ({
        code: String(s.code ?? "").trim().slice(0, 1),
        value: stripFraming(String(s.value ?? "")).trim(),
      }))
      .filter((s) => s.code !== "" && s.value !== "");
    if (subfields.length === 0) continue;

    consider({
      tag,
      ind1: (String(f.ind1 ?? " ") || " ").slice(0, 1),
      ind2: (String(f.ind2 ?? " ") || " ").slice(0, 1),
      value: null,
      subfields,
    });
  }

  // Appended after the loop so the carried-over control number is subject to
  // the same budget as everything else rather than smuggled past it.
  if (carried) consider(carried);

  return { fields: kept, truncated, dropped };
}

/** Rough serialised size of a payload, for bounding what crosses the wire. */
export function marcPayloadBytes(fields: SourceField[]): number {
  return fields.reduce((n, f) => n + 4 + fieldBytes(f), 0);
}
