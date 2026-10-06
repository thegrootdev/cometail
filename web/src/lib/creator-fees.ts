// What a pool's counters prove about the creator's past claims (worker feeindex.ts creatorClaims).
// Meteora floors the creator's share on every trade, so the lifetime counter times the share is an
// upper bound of the true total (exact at a 0% or 100% share). Claimable is the pool's own exact
// field, so what was already claimed is AT MOST lifetime minus claimable, and nothing was claimed
// for certain only when the two are equal. Partial claims exist: no small gap is read as none.
export function creatorClaims(estimate: bigint, claimable: bigint, pct: number): { claimedAtMost: bigint; lifetimeExact: boolean; noneClaimed: boolean } {
  return { claimedAtMost: estimate > claimable ? estimate - claimable : 0n, lifetimeExact: pct === 0 || pct === 100, noneClaimed: estimate === claimable };
}
