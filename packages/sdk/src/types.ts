/** Base58 addresses/signatures and raw integers stay strings; amounts never become JS numbers. */
export type Address = string;
export type RawAmount = string;
export type Cursor = string;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export interface Provenance {
  source: "chain" | "indexer" | "estimate";
  signature?: string;
  slot?: number;
  scannedAtMs?: number;
}
export interface EstimateLabel { path: string; source: "estimate"; basis: string }
/** SDK annotations. Missing wire provenance is explicitly labelled indexer, never chain. */
export interface Evidence { provenance: Provenance; estimates: EstimateLabel[] }
export interface Coverage { status: "complete" | "partial" | "stale"; pendingPools: number; lastSuccessfulAtMs: number | null }
export interface QuoteUsd { value: number | null; source: string | null; status: "fresh" | "missing" }
export interface SolUsd { value: number; source: string; observedAtMs: number; status: "fresh" | "stale"; valuationBasis: "market" | "reference" }
export interface Envelope<T> extends Evidence {
  schemaVersion: 1; cluster: string; generatedAtMs: number; observedSlot: number | null;
  coverage: Coverage; solUsd: SolUsd | null; data: T;
}
export interface TokenLinks { x: string | null; telegram: string | null; discord: string | null; website: string | null }
export type Stage = "bonding" | "completed" | "graduated";
export type Custody = "wallet" | "program" | "unknown";
export interface TokenIdentity {
  mint: Address; name: string; symbol: string; imageUrl: string | null; stage: Stage; links: TokenLinks | null;
}
export interface Token extends Evidence {
  identity: TokenIdentity & {
    decimals: number; metadataUri: string | null; metadataStatus: "ok" | "missing" | "unreachable";
    creator: Address; custody: Custody; createdAtMs: number | null; dbcPool: Address; dammPool: Address | null;
    quoteMint: Address; tokenKind: "plain" | "stream"; config: Address; vault: Address | null;
  };
  market: {
    priceQuote: string | null; quoteMint: Address; quoteDecimals: number; quoteUsd: QuoteUsd;
    priceSol: string | null; priceSource: string | null; priceAtMs: number; totalSupplyRaw: RawAmount;
    circulatingSupplyRaw: null; fdvUsd: string | null; marketCapUsd: null; valuationBasis: "fdv";
    liquidityLamports: RawAmount | null; liquidityBasis: "curve-quote-reserve" | "damm-quote-x2" | null;
  };
  volume24h: { lamports: RawAmount; buys: number; sells: number; windowEndMs: number; windowStartMs: number; complete: boolean; status: "complete" | "partial" };
  holders: { count: number | null; countedAtMs: number | null; status: "missing" | "ok"; definition: string };
  bonding: { progressBps: number | null; quoteRaisedLamports: RawAmount; targetLamports: RawAmount; migrationStage: Stage };
  updatedAtMs: number;
}
export interface TokenList { volumeRanking?: { basis: "quote-usd-v1"; unrated: "newest" }; tokens: Token[]; total: number; nextCursor: string | null; sort: "volume24h" | "newest"; stage: string }
export interface Trade extends Evidence {
  id: string; signature: string; ordinal: number; slot: number; blockTimeSec: number | null;
  pool: Address; venue: "curve" | "damm" | null; side: "buy" | "sell";
  baseAmountRaw: RawAmount | null; quoteAmountLamports: RawAmount | null; executionPriceSol: string | null;
  executionPriceQuote: string | null; quoteMint: Address; quoteDecimals: number;
  trader: Address; traderKind: "authority" | "feePayer";
}
export interface SkyStream extends Evidence {
  pool: Address; config: Address; baseMint: Address; quoteMint: Address; creator: Address; custody: Custody;
  progress: number; eligible: boolean; reasons: string[]; creatorPct: number; partnerPct: number; creatorFeePct: number;
  claimableLamports: RawAmount; realizedEstimateLamports: RawAmount;
  realized7dLamports: RawAmount | null; realized30dLamports: RawAmount | null; vault: Address | null;
  tradingFeeLamports: RawAmount; dammPool: Address | null; updatedAt: number;
  kind?: "curve" | "position"; position?: Address | null; owner?: Address; lockedSharePct?: number;
  token: TokenIdentity | null;
}
/** Open account objects retain fields added by the program/indexer without discarding them. */
export interface VaultAccount {
  [key: string]: unknown;
  depositor: Address; stMint: Address; status: Record<string, JsonObject>; preset: number;
  dbcPool: Address; dammPool: Address; dlmmPair: Address; streamCount: number; activeStreams: number;
  accounting: Record<"harvestedGross" | "toDepositor" | "toProtocol" | "income" | "cashedOut" | "routedGross" | "refundedPrincipal" | "orderFeesWsol" | "burnedSt", RawAmount>;
  reconciliation?: { fromEvents: Record<string, RawAmount>; matches: boolean; mismatches: string[]; checkedAt: number };
  live?: { updatedAt: number; ladder: JsonObject | null };
}
export interface Vault extends Evidence { vault: Address; data: VaultAccount; updatedAt: number; stToken: TokenIdentity | null }
export interface Stream extends Evidence {
  stream: Address;
  data: { [key: string]: unknown; vault: Address; index: number; kind: Record<string, JsonObject>; isOwn: boolean; pool: Address; harvested: RawAmount };
  token: TokenIdentity | null;
}
export interface VaultEvent extends Evidence { signature: string; idx: number; slot: number; blockTime: number | null; name: string; vault: Address | null; data: JsonObject }
/** /vaults/:vault uses the store's trade shape, different from /tokens/:mint/trades. */
export interface VaultTrade extends Evidence {
  signature: string; idx: number; slot: number; blockTime: number | null; pool: Address; vault: Address | null;
  trader: Address; traderKind: "authority" | "feePayer"; buy: boolean; amountIn: RawAmount; amountOut: RawAmount;
  venue?: "curve" | "damm"; baseAmountRaw?: RawAmount; quoteAmountLamports?: RawAmount; executionPriceSol?: string | null;
}
export interface VaultDetail extends Vault { streams: Stream[]; events: VaultEvent[]; trades: VaultTrade[] }
export type Classified<T> = { independent: T; demo: T; unattributed: T };
export interface Metrics extends Evidence {
  generatedAt: number; demoActors: Address[]; incomplete: boolean; notes: string[];
  plainLaunches: { count: Classified<number>; tradingFeeLamports: Classified<RawAmount>; volumeEstimateLamports: Classified<RawAmount> };
  recurringIncomeLamports: { external: Classified<RawAmount>; own: Classified<RawAmount> };
  oneTimeProceedsLamports: { external: Classified<RawAmount>; own: Classified<RawAmount> };
  depositors: { independent: number; demo: number };
  buyers: { distinct: Classified<number>; buyVolumeLamports: Classified<RawAmount>; purchases: number; sales: number; poolsPending: number };
  launchTraders: { distinct: Classified<number>; trades: number }; bidDepthLamports: Classified<RawAmount>;
  fillsAndBurns: { settledWithBurn: Classified<number>; burnedSt: Classified<RawAmount> };
  refundedPrincipalLamports: Classified<RawAmount>;
}
export interface Prices extends Evidence { solUsd: number; source: string; at: number }
export interface Health extends Evidence { ok: boolean; service: string; time: number }
export interface FeedData {
  launch: { mint: Address; name: string; symbol: string; imageUrl: string | null; creator: Address; config: Address; dbcPool: Address; tokenKind: "plain" | "stream"; quoteMint?: Address; stage?: Stage; createdAtMs?: number | null };
  trade: { executionPriceQuote: string | null; quoteMint: Address; quoteDecimals: number; mint: Address | null; pool: Address; venue: "curve" | "damm" | null; side: "buy" | "sell"; baseAmountRaw: RawAmount | null; quoteAmountLamports: RawAmount | null; executionPriceSol: string | null; trader: Address; signature: string; traderKind?: "authority" | "feePayer" };
  graduation: { mint: Address; dbcPool: Address; dammPool: Address | null; quoteMint?: Address; signature?: string };
  harvest: { vault: Address; stream: Address | null; incomeLamports: RawAmount | null; signature: string; grossLamports?: RawAmount | null; toDepositorLamports?: RawAmount | null; toProtocolLamports?: RawAmount | null; oneTime?: boolean };
  bid: { vault: Address; order: Address | null; bins: number; grossLamports: RawAmount | null; signature: string };
  fill: { vault: Address; order: Address | null; burnedStRaw: RawAmount | null; unfilledLamports: RawAmount | null; signature: string };
  cashout: { vault: Address; depositorLamports: RawAmount | null; signature: string };
  unwind: { vault: Address; stMint: Address | null; dbcPool: Address | null; incomeReturned: RawAmount | null; launchedAt?: string | null; unwoundAt?: string | null; signature: string };
  vault: { vault: Address; event: string; signature: string; [key: string]: Json };
  /** A creator or partner fee claimed on a DBC pool of any launchpad, from the claim event itself. */
  claim: { mint: Address | null; pool: Address; role: "creator" | "partner"; quoteAmountLamports: RawAmount; baseAmountRaw: RawAmount; signature: string };
}
export type FeedType = keyof FeedData;
/** The fee events: claims, vault harvests, buyback bids, and fills (whose burnedStRaw is the burn). */
export const FEE_TYPES = ["claim", "harvest", "bid", "fill"] as const satisfies readonly FeedType[];
type Origin<T> = { provenance: Provenance & { source: "chain" | "indexer" }; data: T & { basis?: string } } | { provenance: Provenance & { source: "estimate" }; data: T & { basis: string } };
export type FeedEvent = { [K in FeedType]: { schemaVersion: 1; cluster: string; type: K; cursor: Cursor; observedSlot: number | null; generatedAtMs: number } & Origin<FeedData[K]> }[FeedType];
/** `oldest` is null when the feed is empty; `resume` is then the reset cursor "0:0:~", accepted before and after the first event. */
export interface GapFrame { type: "gap"; oldest: Cursor | null; resume: Cursor }
export type ControlFrame = GapFrame | { type: "hello"; cursor: Cursor | null; retentionSlots: number } | { type: "ping"; generatedAtMs: number } | ({ type: "coverage" } & Coverage);
export type FeedFrame = FeedEvent | ControlFrame;
export interface FeedReplay { schemaVersion: 1; cluster: string; type: "replay"; generatedAtMs: number; events: FeedEvent[]; nextCursor: Cursor | null; types?: FeedType[] }
/** One coin in the Fee Index: a SOL-paired DBC coin of any launchpad and what its creator earns on the curve. */
export interface FeeCoin {
  mint: Address; pool: Address; config: Address; creator: Address; launchpad: Address | null; ours: boolean; name: string | null; symbol: string | null;
  /** The https image from the coin's metadata file; null until read, or when it has none. */
  imageUrl: string | null;
  stage: "bonding" | "migrating" | "graduated"; creatorFeePct: number | null;
  /** Estimates (see the answer's `basis`): the counter times the creator percentage; the program floors per swap.
   *  The lifetime is never below claimableLamports and equals it exactly when `nothingClaimed`. */
  creatorLifetimeEstimateLamports: RawAmount; creatorClaimedEstimateLamports: RawAmount; nothingClaimed: boolean; creatorLast24hEstimateLamports: RawAmount; last24hWindowHours: number; creatorAvgPerDayEstimateLamports: RawAmount;
  /** Exact: the pool's unclaimed creator fee. */
  claimableLamports: RawAmount; launchedAtMs: number;
  /** The config part of the vault's deposit rules and a stage it accepts; the deposit also checks the coin's mint. */
  configAllowsTail: boolean; reasons: string[]; changedAtMs: number;
}
export interface FeeCoverage { mode: "all-dbc"; pools: number; configs: number; fullSlot: number; deltaSlot: number; fullAtMs: number; deltaAtMs: number; fullEveryHours: number; deltaEveryMinutes: number; historySinceMs: number; fullDayOfHistory: boolean; claims: Record<string, number> }
export interface FeeEnvelope { schemaVersion: 1; cluster: string; generatedAtMs: number; coverage: FeeCoverage }
export interface Launchpad { rank: number; launchpad: Address; ours: boolean; coins: number; configs: number; graduated: number; tailEligibleCoins: number; creatorLifetimeEstimateLamports: RawAmount; creatorLast24hEstimateLamports: RawAmount; coinsWithShorterWindow: number; claimableLamports: RawAmount; creatorFeePct: number | null }
export type OurConfig = { config: Address; covered: false; note: string } | { config: Address; covered: true; launchpad: Address; creatorFeePct: number; tailEligibleConfig: boolean; coins: number; graduated: number; creatorLifetimeEstimateLamports: RawAmount; creatorLast24hEstimateLamports: RawAmount; claimableLamports: RawAmount };
/** One tail (a vault's fee token). A null field could not be computed; it is never a zero. */
export interface Tail {
  vault: Address; status: string; stMint: Address; name: string | null; symbol: string | null; imageUrl: string | null; decimals: number | null;
  sources: { stream: Address; kind: string; pool: Address; mint: Address | null; name: string | null; symbol: string | null; imageUrl: string | null }[];
  raise: { raisedLamports: RawAmount; targetLamports: RawAmount; progressBps: number | null; stage: string | null } | null;
  feesIn: { lifetimeLamports: RawAmount; last24hLamports: RawAmount };
  /** placed is cumulative; filled = placed - refunded - resting, null while resting principal is unknown. */
  bids: { placedLamports: RawAmount; refundedLamports: RawAmount; restingLamports: RawAmount | null; filledLamports: RawAmount | null };
  burnedStRaw: RawAmount; unwindOpensAtSec: number | null;
}
export interface RequestOptions { signal?: AbortSignal }
export interface TokenQuery { sort?: "volume24h" | "newest"; stage?: "bonding" | "graduated" | "all"; q?: string; limit?: number; cursor?: string }
