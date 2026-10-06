// What each estimated Fee Index field means; carried by every answer that holds one. Dependency-free so
// the read API can import it without loading the chain client.
export const ESTIMATE_BASIS = {
  creatorLifetimeEstimateLamports: "lifetime trading-fee counter (metrics.totalTradingQuoteFee) times the config's creator trading-fee percentage: an upper bound, since the program floors the creator share swap by swap (lower by under a lamport per swap); exact when `lifetimeExact` (a 0% or 100% share)",
  creatorClaimedAtMostLamports: "an upper bound of what the creator already claimed: the lifetime figure minus claimableLamports; exact when `lifetimeExact`. `noneClaimed` is true only when the two are equal, which proves no claim; a small gap does not prove one (rounding) and is not read as none (partial claims exist)",
  claimableLamports: "exact: the pool's creator quote fee, what a creator claim pays now",
  creatorLast24hEstimateLamports: "growth of the same counter since the end of the hour 24 hours back (hourly snapshots of the last observed value), times the creator percentage; `last24hWindowHours` below 24 means the index holds less history for this coin",
  creatorAvgPerDayEstimateLamports: "the lifetime estimate divided by the days since activation (at least one)",
} as const;
