// What each estimated Fee Index field means; carried by every answer that holds one. Dependency-free so
// the read API can import it without loading the chain client.
export const ESTIMATE_BASIS = {
  creatorLifetimeEstimateLamports: "lifetime trading-fee counter (metrics.totalTradingQuoteFee) times the config's creator trading-fee percentage, never below claimableLamports; the program floors the creator share swap by swap, so the counter can overshoot by under a lamport per swap. When it is within the smaller of 0.0001 SOL and 0.1% of itself of claimableLamports, nothing was claimed (`nothingClaimed`) and this IS claimableLamports, exact",
  creatorClaimedEstimateLamports: "what the creator already claimed: the lifetime figure minus claimableLamports; 0 when `nothingClaimed` (a gap that small is per-swap rounding)",
  claimableLamports: "exact: the pool's creator quote fee, what a creator claim pays now",
  creatorLast24hEstimateLamports: "growth of the same counter since the end of the hour 24 hours back (hourly snapshots of the last observed value), times the creator percentage; `last24hWindowHours` below 24 means the index holds less history for this coin",
  creatorAvgPerDayEstimateLamports: "the lifetime estimate divided by the days since activation (at least one)",
} as const;
