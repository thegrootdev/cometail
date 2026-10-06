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

async function get<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
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
  creatorLifetimeEstimateLamports: string; creatorClaimedEstimateLamports: string; nothingClaimed: boolean; creatorLast24hEstimateLamports: string; last24hWindowHours: number; creatorAvgPerDayEstimateLamports: string;
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
export const api = {
  feeCoins: (q: { sort: string; stage: string; eligible: boolean; creator?: string | null; q?: string; offset?: number; limit?: number }) => {
    const p = new URLSearchParams({ sort: q.sort, stage: q.stage, limit: String(q.limit ?? 50), offset: String(q.offset ?? 0) });
    if (q.eligible) p.set("eligible", "1"); if (q.creator) p.set("creator", q.creator); if (q.q) p.set("q", q.q);
    return get<{ coverage: FeeCoverage; coins: FeeCoin[]; offset: number; limit: number }>(`/api/fees/coins?${p}`);
  },
  feeCoin: (mint: string) => get<{ coverage: FeeCoverage; coin: FeeCoin }>(`/api/fees/coins/${encodeURIComponent(mint)}`),
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
