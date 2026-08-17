import { prisma } from "@/lib/db";

export type EffectivePolicy = {
  loanDays: number;
  maxLoans: number;
  maxRenewals: number;
  renewalDays: number;
  digitalDays: number;
  holdPickupDays: number;
  // Overdue charges (see src/lib/fines.ts).
  fineCentsPerDay: number;
  fineGraceDays: number;
  maxFineCents: number | null;
};

// Code-level backstop if the LoanPolicy table is empty (pre-seed).
const FALLBACK: EffectivePolicy = {
  loanDays: 14,
  maxLoans: 5,
  maxRenewals: 2,
  renewalDays: 14,
  digitalDays: 14,
  holdPickupDays: 3,
  fineCentsPerDay: 0,
  fineGraceDays: 0,
  maxFineCents: null,
};

/**
 * Resolve the circulation policy on the member-type x item-type matrix, most
 * specific first:
 *   (memberType, itemType) → (memberType, any) → (DEFAULT, itemType)
 *   → (DEFAULT, any) → code fallback
 * Passing no item type resolves the "any item type" row, which is how every
 * pre-matrix policy behaves.
 */
export async function policyFor(
  memberType: string,
  itemTypeId?: string | null,
): Promise<EffectivePolicy> {
  const rows = await prisma.loanPolicy.findMany({
    where: {
      memberType: { in: [memberType, "DEFAULT"] },
      ...(itemTypeId
        ? { OR: [{ itemTypeId }, { itemTypeId: null }] }
        : { itemTypeId: null }),
    },
  });
  const pick = (mt: string, it: string | null) =>
    rows.find((r) => r.memberType === mt && r.itemTypeId === it);

  const src =
    (itemTypeId ? pick(memberType, itemTypeId) : undefined) ??
    pick(memberType, null) ??
    (itemTypeId ? pick("DEFAULT", itemTypeId) : undefined) ??
    pick("DEFAULT", null);
  if (!src) return FALLBACK;
  return {
    loanDays: src.loanDays,
    maxLoans: src.maxLoans,
    maxRenewals: src.maxRenewals,
    renewalDays: src.renewalDays,
    digitalDays: src.digitalDays,
    holdPickupDays: src.holdPickupDays,
    fineCentsPerDay: src.fineCentsPerDay,
    fineGraceDays: src.fineGraceDays,
    maxFineCents: src.maxFineCents,
  };
}
