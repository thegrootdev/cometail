// The creator-fee rule the Fee Index applies (worker feeindex.ts creatorLifetime): Meteora floors the
// creator's share on every trade, so the lifetime counter times the share overshoots the true total by
// under a lamport per trade. Claimable is the pool's own exact field. A gap within the smaller of
// 0.0001 SOL and 0.1% of the estimate is that rounding, not a claim: nothing was claimed and the
// lifetime is the claimable amount.
export const ROUNDING_ALLOWANCE = 100_000n;
const allowance = (estimate: bigint) => (estimate / 1000n < ROUNDING_ALLOWANCE ? estimate / 1000n : ROUNDING_ALLOWANCE);
export function creatorLifetime(estimate: bigint, claimable: bigint): { lifetime: bigint; claimed: bigint; nothingClaimed: boolean } {
  if (estimate <= claimable + allowance(estimate)) return { lifetime: claimable, claimed: 0n, nothingClaimed: true };
  return { lifetime: estimate, claimed: estimate - claimable, nothingClaimed: false };
}
