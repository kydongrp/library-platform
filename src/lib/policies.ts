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
 * Resolve the circulation policy for a member type: exact row, then the
 * DEFAULT row, then the code fallback.
 */
export async function policyFor(memberType: string): Promise<EffectivePolicy> {
  const rows = await prisma.loanPolicy.findMany({
    where: { memberType: { in: [memberType, "DEFAULT"] } },
  });
  const exact = rows.find((r) => r.memberType === memberType);
  const def = rows.find((r) => r.memberType === "DEFAULT");
  const src = exact ?? def;
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
