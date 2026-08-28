/**
 * ISO 2709 (.mrc) reader: binary MARC21 records in, MarcRecord out.
 *
 * The counterpart to toMarc2709 in src/lib/marc.ts. Vendors ship binary .mrc
 * far more often than MARCXML, and a .mrc file cannot be read as text: the
 * format frames data with control bytes (0x1F subfield, 0x1E field, 0x1D
 * record) and stores byte offsets in the directory, so any transcoding shifts
 * the offsets and the record falls apart.
 *
 * Pure: bytes in, records out. No network, no database.
 *
 * Written defensively. A batch from a supplier is not a trusted, well-formed
 * document: real files contain records with wrong length bytes, a stray
 * terminator, MARC-8 text where UTF-8 was declared, and a truncated final
 * record where a transfer was cut short. One bad record must not lose the other
 * four thousand, so parsing is per-record and failures are reported rather than
 * thrown.
 */

const SUBFIELD_DELIM = 0x1f;
const FIELD_TERM = 0x1e;
const RECORD_TERM = 0x1d;

const LEADER_LEN = 24;
const DIR_ENTRY_LEN = 12;

export type BinaryField = {
  tag: string;
  /** Control fields (00X) carry a value and no indicators or subfields. */
  value?: string;
  ind1?: string;
  ind2?: string;
  subs?: [string, string][];
};

export type BinaryRecord = {
  leader: string;
  fields: BinaryField[];
};

export type ParsedMarcBinary = {
  records: BinaryRecord[];
  /** One line per record that could not be read, for the import summary. */
  errors: string[];
  /** Encoding actually used to decode text. */
  encoding: "utf-8" | "iso-8859-1";
};

/**
 * Leader/09 says "a" for UTF-8 and a space for MARC-8.
 *
 * MARC-8 is a bespoke multi-byte encoding with no TextDecoder support. Rather
 * than pretend, non-UTF-8 files are decoded as latin1, which keeps ASCII
 * (the overwhelming majority of a bibliographic record) intact and leaves
 * accented characters wrong but visible, so a cataloguer can spot and fix them.
 * Silently producing mojibake with no warning is worse; the caller surfaces
 * this in the import summary.
 */
function encodingFor(leaderByte: number): "utf-8" | "iso-8859-1" {
  return leaderByte === 0x61 ? "utf-8" : "iso-8859-1";
}

function decoderFor(encoding: "utf-8" | "iso-8859-1"): TextDecoder {
  return new TextDecoder(encoding, { fatal: false });
}

/**
 * Split a buffer into record-sized slices.
 *
 * The leader's first five bytes give the record length, and that is the
 * authoritative framing. But those bytes are wrong often enough in the wild
 * that a reader trusting them alone loses the rest of the file, so the length
 * is sanity-checked against the next record terminator and the terminator wins
 * when they disagree.
 */
export function sliceRecords(bytes: Uint8Array): { slices: Uint8Array[]; errors: string[] } {
  const slices: Uint8Array[] = [];
  const errors: string[] = [];
  let pos = 0;

  while (pos < bytes.length) {
    // Skip any padding or stray terminators between records.
    while (pos < bytes.length && (bytes[pos] === RECORD_TERM || bytes[pos] === 0x0a || bytes[pos] === 0x0d)) {
      pos++;
    }
    if (pos >= bytes.length) break;

    if (bytes.length - pos < LEADER_LEN) {
      errors.push(`Trailing ${bytes.length - pos} byte(s) after the last record were ignored.`);
      break;
    }

    // Declared length from leader/00-04.
    let declared = 0;
    let digits = true;
    for (let i = 0; i < 5; i++) {
      const c = bytes[pos + i];
      if (c < 0x30 || c > 0x39) {
        digits = false;
        break;
      }
      declared = declared * 10 + (c - 0x30);
    }

    // Where the next record terminator actually is.
    let term = -1;
    for (let i = pos + LEADER_LEN; i < bytes.length; i++) {
      if (bytes[i] === RECORD_TERM) {
        term = i;
        break;
      }
    }

    let end: number;
    if (digits && declared >= LEADER_LEN && pos + declared <= bytes.length) {
      end = pos + declared;
      // The declared length should land exactly on a terminator. When it does
      // not, believe the terminator: a wrong length byte is common, and using
      // it would desynchronise every following record.
      if (bytes[end - 1] !== RECORD_TERM && term !== -1 && term + 1 !== end) {
        errors.push(
          `A record declared ${declared} bytes but its terminator is at ${term - pos + 1}; used the terminator.`,
        );
        end = term + 1;
      }
    } else if (term !== -1) {
      if (digits) {
        errors.push(`A record declared ${declared} bytes, which overruns the file; used the terminator.`);
      } else {
        errors.push("A record had a non-numeric length in its leader; used the terminator.");
      }
      end = term + 1;
    } else {
      errors.push("The final record has no terminator and was ignored as truncated.");
      break;
    }

    slices.push(bytes.subarray(pos, end));
    pos = end;
  }

  return { slices, errors };
}

/** Parse one record slice. Returns null when the slice is unusable. */
export function parseRecordSlice(
  slice: Uint8Array,
  decode: (b: Uint8Array) => string,
): { record: BinaryRecord | null; error?: string } {
  if (slice.length < LEADER_LEN) return { record: null, error: "Record shorter than a leader." };

  const leader = decode(slice.subarray(0, LEADER_LEN));

  // Base address of data, leader/12-16.
  const baseRaw = leader.slice(12, 17);
  const base = /^\d{5}$/.test(baseRaw) ? Number(baseRaw) : NaN;
  if (!Number.isFinite(base) || base < LEADER_LEN || base > slice.length) {
    return { record: null, error: `Record has an unusable base address "${baseRaw}".` };
  }

  const dirBytes = slice.subarray(LEADER_LEN, base);
  // The directory ends with a field terminator; entries are 12 bytes each.
  const dirLen = dirBytes.length > 0 && dirBytes[dirBytes.length - 1] === FIELD_TERM
    ? dirBytes.length - 1
    : dirBytes.length;
  if (dirLen % DIR_ENTRY_LEN !== 0) {
    return { record: null, error: `Record directory is ${dirLen} bytes, not a multiple of 12.` };
  }

  const fields: BinaryField[] = [];
  for (let i = 0; i + DIR_ENTRY_LEN <= dirLen; i += DIR_ENTRY_LEN) {
    const entry = decode(dirBytes.subarray(i, i + DIR_ENTRY_LEN));
    const tag = entry.slice(0, 3);
    const lenRaw = entry.slice(3, 7);
    const offRaw = entry.slice(7, 12);
    if (!/^\d{4}$/.test(lenRaw) || !/^\d{5}$/.test(offRaw)) continue; // skip a corrupt entry
    const len = Number(lenRaw);
    const off = Number(offRaw);

    const start = base + off;
    let end = start + len;
    if (start >= slice.length) continue;
    if (end > slice.length) end = slice.length;

    let data = slice.subarray(start, end);
    // Drop the trailing field terminator if present.
    if (data.length > 0 && data[data.length - 1] === FIELD_TERM) data = data.subarray(0, -1);

    // 00X are control fields: no indicators, no subfields.
    if (tag.startsWith("00")) {
      fields.push({ tag, value: decode(data) });
      continue;
    }

    if (data.length < 2) {
      // A data field with no room for indicators is not usable, but the rest of
      // the record still is.
      fields.push({ tag, ind1: " ", ind2: " ", subs: [] });
      continue;
    }

    const ind1 = decode(data.subarray(0, 1)) || " ";
    const ind2 = decode(data.subarray(1, 2)) || " ";

    const subs: [string, string][] = [];
    let i2 = 2;
    while (i2 < data.length) {
      if (data[i2] !== SUBFIELD_DELIM) {
        i2++;
        continue;
      }
      const codeIdx = i2 + 1;
      if (codeIdx >= data.length) break;
      const code = decode(data.subarray(codeIdx, codeIdx + 1));
      let valEnd = codeIdx + 1;
      while (valEnd < data.length && data[valEnd] !== SUBFIELD_DELIM) valEnd++;
      subs.push([code, decode(data.subarray(codeIdx + 1, valEnd))]);
      i2 = valEnd;
    }

    fields.push({ tag, ind1, ind2, subs });
  }

  if (fields.length === 0) {
    return { record: null, error: "Record contained no readable fields." };
  }
  return { record: { leader, fields } };
}

/**
 * Read a binary MARC21 (.mrc) file.
 *
 * Never throws. A record that cannot be read is reported and skipped so the
 * rest of the batch still imports.
 */
export function parseMarcBinary(bytes: Uint8Array): ParsedMarcBinary {
  if (bytes.length === 0) {
    return { records: [], errors: ["The file is empty."], encoding: "utf-8" };
  }

  // Leader/09 of the FIRST record decides the encoding for the file. Mixed
  // encodings within one file exist but are pathological; a single decoder
  // keeps the reader honest about what it did.
  const encoding = bytes.length > 9 ? encodingFor(bytes[9]) : "utf-8";
  const decoder = decoderFor(encoding);
  const decode = (b: Uint8Array) => decoder.decode(b);

  const { slices, errors } = sliceRecords(bytes);
  const records: BinaryRecord[] = [];

  for (const [i, slice] of slices.entries()) {
    const { record, error } = parseRecordSlice(slice, decode);
    if (record) records.push(record);
    else if (error) errors.push(`Record ${i + 1}: ${error}`);
  }

  if (records.length === 0 && errors.length === 0) {
    errors.push("No MARC records were found. Is this a binary .mrc file?");
  }
  return { records, errors, encoding };
}

/** Looks like ISO 2709: a 5-digit length, and a field terminator where the leader ends. */
export function looksLikeMarcBinary(bytes: Uint8Array): boolean {
  if (bytes.length < LEADER_LEN) return false;
  for (let i = 0; i < 5; i++) {
    if (bytes[i] < 0x30 || bytes[i] > 0x39) return false;
  }
  // A record terminator must appear somewhere, and the directory must be a
  // plausible length.
  const baseRaw = String.fromCharCode(...bytes.subarray(12, 17));
  if (!/^\d{5}$/.test(baseRaw)) return false;
  return bytes.includes(RECORD_TERM) || bytes.includes(FIELD_TERM);
}
