// The worker's read API (worker/src/api.ts). Every call fails soft: pages render what they
// can from the chain when the API is down.
import { API_URL } from "./addresses";
import type { TokenIdentity } from "./token-display";

export interface SkyStream {
  token?: TokenIdentity | null;
  pool: string;
  config: string;
  baseMint: string;
  quoteMint: string;
  creator: string;
  custody: "wallet" | "program" | "unknown";
  progress: number;
  eligible: boolean;
  reasons: string[];
  creatorPct: number;
  partnerPct: number;
  creatorFeePct: number;
  claimableLamports: string;
  realizedEstimateLamports: string;
  realized7dLamports: string | null;
  realized30dLamports: string | null;
  vault: string | null;
  tradingFeeLamports: string;
  dammPool: string | null;
  updatedAt: number;
  kind?: "curve" | "position";
  position?: string | null;
  owner?: string;
  lockedSharePct?: number;
  ownerRole?: "treasury" | "vault";
}
export interface VaultRow {
  stToken?: TokenIdentity | null;
  vault: string;
  data: any;
  updatedAt: number;
}
export interface EventRow {
  signature: string;
  idx: number;
  slot: number;
  blockTime: number | null;
  name: string;
  vault: string | null;
  data: any;
}

/** How long a Fee Index text search may take before the page reports it as failed. */
export const FEE_SEARCH_TIMEOUT_MS = 30_000;

async function get<T>(path: string, timeoutMs = 12_000): Promise<T | null> {
  try {
    const r = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}
/** The Fee Index (worker feeindex.ts, docs/api.md "The Fee Index"). */
export interface FeeCoin {
  mint: string; pool: string; config: string; creator: string; launchpad: string | null; ours: boolean; name: string | null; symbol: string | null; imageUrl: string | null;
  stage: "bonding" | "migrating" | "graduated"; creatorFeePct: number | null;
  creatorLifetimeEstimateLamports: string; lifetimeExact: boolean; creatorClaimedAtMostLamports: string; noneClaimed: boolean; creatorLast24hEstimateLamports: string; last24hWindowHours: number; creatorAvgPerDayEstimateLamports: string;
  claimableLamports: string; launchedAtMs: number; configAllowsTail: boolean; reasons: string[]; changedAtMs: number;
}
export interface FeeCoverage { mode: string; pools: number; configs: number; fullAtMs: number; deltaAtMs: number; fullEveryHours: number; deltaEveryMinutes: number; historySinceMs: number; fullDayOfHistory: boolean }
export interface Launchpad { rank: number; launchpad: string; ours: boolean; coins: number; configs: number; graduated: number; tailEligibleCoins: number; creatorLifetimeEstimateLamports: string; creatorLast24hEstimateLamports: string; coinsWithShorterWindow: number; claimableLamports: string; creatorFeePct: number | null }
export type OurConfig = { config: string; covered: false; note: string } | { config: string; covered: true; launchpad: string; creatorFeePct: number; tailEligibleConfig: boolean; coins: number; graduated: number; creatorLifetimeEstimateLamports: string; creatorLast24hEstimateLamports: string; claimableLamports: string };
export interface Tail {
  vault: string; status: string; stMint: string; name: string | null; symbol: string | null; imageUrl: string | null; decimals: number | null;
  sources: { stream: string; kind: string; pool: string; mint: string | null; name: string | null; symbol: string | null; imageUrl: string | null }[];
  raise: { raisedLamports: string; targetLamports: string; progressBps: number | null; stage: string | null } | null;
  feesIn: { lifetimeLamports: string; last24hLamports: string };
  bids: { placedLamports: string; refundedLamports: string; restingLamports: string | null; filledLamports: string | null };
  burnedStRaw: string; unwindOpensAtSec: number | null;
}
/** /api/burn (worker burnview.ts, docs/burn.md). Exact counters are strings of raw units; null is unknown, never zero. */
export type BurnRow = { signature: string; slot: number; idx: number; blockTime: number | null; spentLamports: string; receivedRaw: string; burnedRaw: string; minOutRaw: string };
/** A tail's claims from /api/tail-claims/:mint (worker/src/tails.ts). Lamports and raw units as strings. Every
 *  creator claim is listed, split or not (`status`); `burn` is null until the reserve's ledger proves where the
 *  claim's SOL went; totals are null until the history they sum is complete. */
export interface TailClaim {
  signature: string; idx: number; slot: number; blockTime: number | null;
  source: "curve" | "pool"; status: "split" | "unsplit" | "incomplete" | "ambiguous";
  claimedLamports: string; keptLamports: string | null; toBurnLamports: string | null;
  burn: { spentLamports: string; waitingLamports: string; boughtRaw: string; buybacks: string[] } | null;
  liquidity: { swapInLamports: string | null; addedLamports: string; addedRaw: string; liquidity: string; locked: boolean; position: string } | null;
  /** For a claim that was not split: the make-up that counts for it, later, from the wallet (absent from a worker
   *  older than make-ups). */
  makeUp?: TailMakeUp | null;
}
export interface TailMakeUp {
  signature: string; idx: number; slot: number; blockTime: number | null; toBurnLamports: string;
  burn: { spentLamports: string; waitingLamports: string; boughtRaw: string; buybacks: string[] } | null;
  liquidity: { swapInLamports: string; addedLamports: string; addedRaw: string; liquidity: string; locked: boolean; position: string };
}
export interface TailInfo {
  mint: string; config: string; curve: string; targetPool: string; creators: string[]; origin: { creator: string; signature: string } | null;
  graduatedPool: string | null; graduatedPositions: string[]; positions: string[];
  totals: { claims: number | null; notSplit: number | null; madeUp?: number | null; ambiguous: number | null; claimedLamports: string | null; toBurnLamports: string | null; boughtRaw: string | null; liquidityLamports: string | null; liquidityRaw: string | null; lockedLiquidity: string | null; payoutLamports: string | null };
  claims: TailClaim[];
  payouts: { signature: string; idx: number; slot: number; blockTime: number | null; kind: "migrationFee" | "surplus"; lamports: string }[];
  /** Every make-up transaction found, counted or not. */
  makeUps?: { signature: string; idx: number; slot: number; blockTime: number | null; claim: string; status: string; counted: boolean }[];
  coverage: { claims: { status: string; atMs: number | null }; reserve: { status: string; atMs: number | null }; reserveVerified: boolean };
}
export interface BurnView {
  program: string; claimer: string; sharePct: number; status: "live" | "not-set-up" | "unavailable"; observedSlot?: number;
  history?: { reconciled: boolean; indexedSplitLamports: string; indexedBurnedRaw: string; indexedBuybacks: number };
  coverage: { status: "complete" | "partial" | "unavailable"; atMs: number | null };
  setup?: { pool: string; cometailMint: string; treasury: string; reserve: string; inbox: string; setupBy: string; feeNumerator: string };
  totals?: { splitLamports: string; toReserveLamports: string; toOtherLamports: string; spentLamports: string; burnedRaw: string; buybacks: number; lastBuyAtSec: number | null };
  provenance?: { claimedByProgramLamports: string | null; claimedByOwnersLamports: string | null; carriedLamports: string | null; basis: string };
  reserve?: { lamports: string } | null; sentDirectLamports?: string | null;
  nextBuyback?: { amountLamports: string; dueAtSec: number; due: boolean } | null;
  cometail?: { mint: string; supplyRaw: string; decimals: number } | null;
  claimableNow?: { programConfigsLamports: string | null; olderConfigsLamports: string | null; basis: string };
  commitment?: { tailsShareLamports: string; tailsShareAsOfMs: number | null; olderConfigClaimsLamports: string | null; basis: string };
  burns?: BurnRow[]; burnsTotal?: number; burnsNextCursor?: string | null;
  splits?: { signature: string; slot: number; blockTime: number | null; source: string; pool: string | null; claimant: string | null; claimedLamports: string; carriedLamports: string; toReserveLamports: string; toOtherLamports: string; other: string }[];
  splitsTotal?: number; splitsNextCursor?: string | null;
}
/** The public proof figures (worker stats.ts, /api/stats). Every null is unknown, never zero. */
export interface StatsLaunch {
  mint: string; symbol: string; name: string; kind: "plain" | "stream"; stage: "bonding" | "completed" | "graduated"; createdAtMs: number | null; config: string;
  creator: string; owner: string | null; team: boolean | null; quoteMint: string; dbcPool: string; dammPool: string | null;
  trades: number; traders: number; volumeLamports: string | null; volumeByVenue: Record<string, string> | null;
  fees: { curveTradingLamports: string | null; curveProtocolLamports: string | null; poolLpLamports: string | null; poolProtocolLamports: string | null };
  lockedBps: number | null;
}
export interface Stats {
  schemaVersion: number; cluster: string; generatedAtMs: number; team: string[];
  launches: { readAtMs: number | null; total: number; team: number; outside: number; unattributed: number; graduated: { total: number; team: number; outside: number }; list: StatsLaunch[] };
  trading: { readAtMs: number | null; complete: boolean; pendingPools: number; trades: number; traders: number | null; volumeLamports: string | null; outsideVolumeLamports: string | null };
  fees: { readAtMs: number | null; slot: number | null; curveTradingLamports: string | null; curveProtocolLamports: string | null; poolLpLamports: string | null; poolProtocolLamports: string | null; totalLamports: string | null; meteoraProtocolLamports: string | null };
  burn: { readAtMs: number; slot: number | null; program: string; reserve: string | null; mint: string | null; burnedRaw: string; buybacks: number; spentLamports: string; splitLamports: string; toReserveLamports: string; lastBuyAtSec: number | null; supplyRaw: string | null; decimals: number | null; reconciled: boolean | null } | null;
  tails: { readAtMs: number; list: { mint: string; claims: number | null; notSplit: number | null; madeUp: number | null; claimedLamports: string | null; toBurnLamports: string | null; liquidityLamports: string | null; liquidityRaw: string | null; complete: boolean }[] } | null;
  vaults: { readAtMs: number | null; total: number; launched: number; list: { vault: string; depositor: string; team: boolean; status: string | null; stMint: string | null; harvestedLamports: string | null; toDepositorLamports: string | null; toProtocolLamports: string | null; waitingLamports: string | null; routedLamports: string | null; burnedStRaw: string | null; readAtMs: number }[] };
  feeIndex: { readAtMs: number | null; mode: string | null; pools: number | null; configs: number | null; claimsConfirmed: number | null; historySinceMs: number | null; refreshMinutes: number | null } | null;
}
export const api = {
  stats: () => get<Stats>("/api/stats"),
  burn: () => get<BurnView>("/api/burn"),
  /** A tail and its claims; "missing" only for a real 404 (not a tail), "error" for anything else. */
  tail: async (mint: string): Promise<{ state: "ok"; tail: TailInfo } | { state: "missing" } | { state: "error" }> => {
    try {
      const r = await fetch(`${API_URL}/api/tail-claims/${encodeURIComponent(mint)}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      if (r.status === 404) return { state: "missing" };
      if (!r.ok) return { state: "error" };
      const j = await r.json();
      return j?.tail ? { state: "ok", tail: j.tail as TailInfo } : { state: "error" };
    } catch { return { state: "error" }; }
  },
  tailList: () => get<{ tails: TailInfo[] }>("/api/tail-claims"),
  burnPage: (before: string) => get<{ total: number; items: BurnRow[]; nextCursor: string | null }>(`/api/burn/burns?limit=50&before=${encodeURIComponent(before)}`),
  /** A text search reads every coin on the server and can take far longer than a listing: it waits up to 30 s. */
  feeCoins: (q: { sort: string; stage: string; eligible: boolean; creator?: string | null; q?: string; offset?: number; limit?: number }) => {
    const p = new URLSearchParams({ sort: q.sort, stage: q.stage, limit: String(q.limit ?? 50), offset: String(q.offset ?? 0) });
    if (q.eligible) p.set("eligible", "1"); if (q.creator) p.set("creator", q.creator); if (q.q) p.set("q", q.q);
    return get<{ coverage: FeeCoverage; coins: FeeCoin[]; offset: number; limit: number }>(`/api/fees/coins?${p}`, q.q ? FEE_SEARCH_TIMEOUT_MS : undefined);
  },
  /** One coin from the Fee Index; "missing" only for a real 404, "error" for an outage or a network failure. */
  feeCoin: async (mint: string): Promise<{ state: "ok"; coin: FeeCoin } | { state: "missing" } | { state: "error" }> => {
    try {
      const r = await fetch(`${API_URL}/api/fees/coins/${encodeURIComponent(mint)}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      if (r.status === 404) return { state: "missing" };
      if (!r.ok) return { state: "error" };
      const body = (await r.json()) as { coin?: FeeCoin };
      return body.coin ? { state: "ok", coin: body.coin } : { state: "error" };
    } catch { return { state: "error" }; }
  },
  feeLaunchpads: () => get<{ coverage: FeeCoverage; rankedBy: "last24h" | "lifetime"; historySinceMs: number; launchpads: Launchpad[]; ourConfigs: OurConfig[] }>("/api/fees/launchpads"),
  tails: (q: { limit?: number; offset?: number; source?: string } = {}) => {
    const p = new URLSearchParams({ limit: String(q.limit ?? 25), offset: String(q.offset ?? 0) }); if (q.source) p.set("source", q.source);
    return get<{ total: number; offset: number; limit: number; tails: Tail[] }>(`/api/tails?${p}`);
  },
  sky: () => get<{ streams: SkyStream[] }>("/api/sky?limit=500"),
  vaults: () => get<{ vaults: VaultRow[] }>("/api/vaults"),
  vault: (key: string) =>
    get<
      VaultRow & {
        streams: { stream: string; data: any; token?: TokenIdentity | null }[];
        events: EventRow[];
      }
    >(`/api/vaults/${key}?limit=100`),
  events: (vault: string) =>
    get<{ events: EventRow[] }>(`/api/events?vault=${vault}&limit=100`),
};
