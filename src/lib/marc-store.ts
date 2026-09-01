/**
 * Persisting an imported record's own MARC fields onto the bib.
 *
 * The rule for WHAT to keep is pure and lives in src/lib/marc-source.ts; this
 * is the database side, the same split as cover-match.ts / cover-images.ts.
 *
 * THE ONE RULE THAT MATTERS: fields are attached only to a record that has
 * NONE. That single condition buys three things at once.
 *
 *   It never overwrites cataloguing. A record a librarian has worked on is left
 *   exactly as they left it, whatever the incoming file says.
 *
 *   It is idempotent. Import the same file twice and the second run attaches
 *   nothing, because the first run's fields are already there.
 *
 *   It repairs the past. Records imported before the importer kept MARC have no
 *   fields at all, so re-uploading the original file gives them their MARC
 *   without creating a single duplicate record: the resource dedup matches them
 *   on access URL and this fills in what was dropped at the time. There is no
 *   other way back for those records, because the source file is not retained.
 *
 * Server-only: it touches prisma.
 */
import { prisma } from "@/lib/db";
import { storableMarcFields, type SourceField } from "@/lib/marc-source";

export type MarcTally = {
  /** Records that gained MARC fields. */
  records: number;
  /** Fields written. */
  fields: number;
  /** Fields whose text was cut to fit the ISO 2709 ceiling. */
  truncated: number;
  /** Fields dropped whole because a record ran past its budget. */
  dropped: number;
  /**
   * Set when the run stopped early. The counts above still describe what was
   * actually written before it stopped, which is the whole point: writes here
   * are batched and not transactional, so a failure half way through leaves
   * real rows in the database. Reporting zero for a run that wrote thousands
   * of fields would be a lie in the direction that hides work, and the audit
   * row would then disagree with the catalogue.
   */
  error: string | null;
};

export function emptyMarcTally(): MarcTally {
  return { records: 0, fields: 0, truncated: 0, dropped: 0, error: null };
}

export function addMarcTally(into: MarcTally, from: MarcTally): void {
  into.records += from.records;
  into.fields += from.fields;
  into.truncated += from.truncated;
  into.dropped += from.dropped;
  into.error = into.error ?? from.error;
}

/** "6 records catalogued from their MARC (94 fields)", or null when nothing happened. */
export function describeMarcTally(t: MarcTally): string | null {
  if (t.records === 0 && !t.error) return null;
  const parts: string[] = [];
  if (t.records > 0)
    parts.push(`${t.records} record${t.records === 1 ? "" : "s"} catalogued from their MARC (${t.fields} field${t.fields === 1 ? "" : "s"})`);
  if (t.truncated) parts.push(`${t.truncated} field${t.truncated === 1 ? "" : "s"} shortened to fit`);
  if (t.dropped) parts.push(`${t.dropped} field${t.dropped === 1 ? "" : "s"} dropped as oversized`);
  if (t.error) parts.push(`cataloguing stopped early (${t.error}); re-run the file to finish it`);
  return parts.join(" · ");
}

const LOOKUP_BATCH = 1_000; // access URLs per existence query
const INSERT_BATCH = 2_000; // MarcField rows per createMany, well under the parameter ceiling

/**
 * Attach source MARC to the records those access URLs identify.
 *
 * Keyed on access URL because that is already this catalogue's identity for a
 * link-out resource: it is what the importer dedups on, so the same key finds
 * both the row just created and the row a previous import created.
 */
export async function attachSourceMarc(byUrl: Map<string, SourceField[]>): Promise<MarcTally> {
  const tally = emptyMarcTally();
  if (byUrl.size === 0) return tally;

  try {
    await attach(byUrl, tally);
  } catch (e) {
    // Never thrown onward, and never at the cost of the tally. Writes are
    // batched and not transactional, so whatever landed before this is real
    // and has to be reported as real. The records that did NOT get their
    // fields are still bare, so re-running the file finishes the job: that is
    // exactly the condition attach() fills.
    tally.error = e instanceof Error ? e.message.slice(0, 200) : "database error";
  }
  return tally;
}

async function attach(byUrl: Map<string, SourceField[]>, tally: MarcTally): Promise<void> {
  const urls = Array.from(byUrl.keys());
  for (let i = 0; i < urls.length; i += LOOKUP_BATCH) {
    const batch = urls.slice(i, i + LOOKUP_BATCH);
    const resources = await prisma.resource.findMany({
      where: { digitalUrl: { in: batch } },
      select: { id: true, digitalUrl: true },
    });
    if (resources.length === 0) continue;

    // One query for the whole batch. Asking per record would be a query per
    // row of a fifty-thousand-row import for a fact that is the same shape
    // every time.
    const ids = resources.map((r) => r.id);
    const already = new Set(
      (
        await prisma.marcField.findMany({
          where: { resourceId: { in: ids } },
          select: { resourceId: true },
          distinct: ["resourceId"],
        })
      ).map((f) => f.resourceId),
    );

    type Row = {
      resourceId: string;
      tag: string;
      ind1: string;
      ind2: string;
      value: string | null;
      subfields: { code: string; value: string }[];
      seq: number;
    };
    // Grouped by record, not flattened, so a batch can never be cut through
    // the middle of one. A record left with half its fields would be the worst
    // outcome available here: it looks catalogued, so the "attach only to a
    // record with none" guard would skip it on every future run, and it would
    // stay half catalogued for good with nothing to show that it happened.
    const perRecord: Row[][] = [];

    for (const r of resources) {
      if (!r.digitalUrl || already.has(r.id)) continue;
      const incoming = byUrl.get(r.digitalUrl);
      if (!incoming?.length) continue;

      // Re-applied here rather than trusted from the caller. The import file is
      // parsed in the BROWSER, so this payload arrived over the wire from a
      // client and its bounds are a claim until we check them ourselves.
      const storable = storableMarcFields(incoming);
      if (storable.fields.length === 0) continue;

      tally.truncated += storable.truncated;
      tally.dropped += storable.dropped;
      perRecord.push(
        storable.fields.map((f, seq) => ({
          resourceId: r.id,
          tag: f.tag,
          ind1: f.ind1,
          ind2: f.ind2,
          value: f.value,
          subfields: f.subfields,
          // 1-based, because the editor's "add field" takes max(seq) + 1 and a
          // zero would make the first hand-added field collide with the first
          // imported one in the display order.
          seq: seq + 1,
        })),
      );
    }

    if (perRecord.length === 0) continue;

    // Pack whole records into batches. The tally is credited only after the
    // insert returns, so a throw leaves the counts describing exactly the
    // records that are actually in the database.
    let slice: Row[] = [];
    let sliceRecords = 0;
    const flush = async () => {
      if (slice.length === 0) return;
      await prisma.marcField.createMany({ data: slice });
      tally.fields += slice.length;
      tally.records += sliceRecords;
      slice = [];
      sliceRecords = 0;
    };
    for (const fields of perRecord) {
      if (slice.length > 0 && slice.length + fields.length > INSERT_BATCH) await flush();
      slice.push(...fields);
      sliceRecords++;
    }
    await flush();
  }
}
