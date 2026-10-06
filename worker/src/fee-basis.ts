// What each estimated Fee Index field means; carried by every answer that holds one. Dependency-free so
// the read API can import it without loading the chain client.
export const ESTIMATE_BASIS = {
  creatorLifetimeEstimateLamports: "lifetime trading-fee counter (metrics.totalTradingQuoteFee) times the config's creator trading-fee percentage; the program floors the creator share swap by swap, so the true sum can be a few lamports per swap lower",
  creatorLast24hEstimateLamports: "growth of the same counter since the end of the hour 24 hours back (hourly snapshots of the last observed value), times the creator percentage; `last24hWindowHours` below 24 means the index holds less history for this coin",
  creatorAvgPerDayEstimateLamports: "the lifetime estimate divided by the days since activation (at least one)",
} as const;
