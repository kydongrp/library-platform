/**
 * Stocktake classification (SDD Items module, comparison row 32). Pure so
 * it's tsx-testable; the stocktake actions do the reads and writes.
 *
 * A scan is classified against the stocktake's scope:
 *   FOUND      the barcode belongs to a copy inside the scope
 *   MISPLACED  a real copy, but catalogued outside the scope (wrong shelf)
 *   UNEXPECTED the barcode is not in the catalogue at all
 *
 * "Missing" is never stored: it is derived as in-scope copies, not on loan,
 * with no scan row, so it stays correct as scanning progresses.
 */

export type ScanScope = {
  collectionId: string | null;
  locationId: string | null;
};

export type ScannableCopy = {
  id: string;
  status: string;
  collectionId: string | null;
  locationId: string | null;
  collectionLabel: string | null; // "REF · Reference", for the detail message
  locationLabel: string | null;
};

export type ScanClassification = {
  result: "FOUND" | "MISPLACED" | "UNEXPECTED";
  detail: string | null;
};

/** True when the copy sits inside the stocktake's scope. */
export function inScope(copy: { collectionId: string | null; locationId: string | null }, scope: ScanScope): boolean {
  if (scope.collectionId && copy.collectionId !== scope.collectionId) return false;
  if (scope.locationId && copy.locationId !== scope.locationId) return false;
  return true;
}

export function classifyScan(copy: ScannableCopy | null, scope: ScanScope): ScanClassification {
  if (!copy) {
    return { result: "UNEXPECTED", detail: "Barcode is not in the catalogue." };
  }
  const notes: string[] = [];
  // An item physically on the shelf while recorded as on loan is a real
  // discrepancy worth surfacing, whatever else is true about it.
  if (copy.status === "ON_LOAN") notes.push("recorded as on loan");
  if (copy.status === "LOST") notes.push("was marked lost");

  if (!inScope(copy, scope)) {
    const where = [copy.collectionLabel, copy.locationLabel].filter(Boolean).join(", ");
    notes.unshift(where ? `catalogued in ${where}` : "catalogued without collection/location codes");
    return { result: "MISPLACED", detail: notes.join(" · ") };
  }
  return { result: "FOUND", detail: notes.length ? notes.join(" · ") : null };
}

/**
 * Copy statuses that are legitimately absent from the shelf during a count.
 * The single source of truth for "expected" arithmetic — the detail page and
 * the close action must both use this, never their own literals.
 */
export const LEGITIMATELY_ABSENT: readonly string[] = ["ON_LOAN"];

export type StocktakeTallies = {
  expected: number; // in-scope copies that should be on the shelf
  onLoan: number; // in-scope copies legitimately absent
  found: number;
  misplaced: number;
  unexpected: number;
  missing: number; // expected minus scanned-on-shelf
  coverage: number; // 0..100, scanned-on-shelf / expected
};

export function tally(input: {
  inScopeTotal: number;
  inScopeOnLoan: number;
  found: number;
  misplaced: number;
  unexpected: number;
  /**
   * Distinct in-scope copies with a scan row, EXCLUDING legitimately-absent
   * ones. A scanned on-loan copy is a discrepancy note, not shelf coverage —
   * counting it here would hide a genuinely missing copy (missing would
   * undercount and coverage overstate, disagreeing with the missing list).
   */
  scannedOnShelf: number;
}): StocktakeTallies {
  const expected = Math.max(0, input.inScopeTotal - input.inScopeOnLoan);
  const missing = Math.max(0, expected - input.scannedOnShelf);
  return {
    expected,
    onLoan: input.inScopeOnLoan,
    found: input.found,
    misplaced: input.misplaced,
    unexpected: input.unexpected,
    missing,
    coverage: expected === 0 ? 100 : Math.round((input.scannedOnShelf / expected) * 100),
  };
}

/** Normalise a scanned barcode: scanners often add whitespace or send lowercase. */
export function normaliseBarcode(raw: string): string {
  return raw.trim().toUpperCase().slice(0, 64);
}
