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
  mint: string; pool: string; config: string; creator: string; launchpad: string | null; ours: boolean; name: string | null; symbol: string | null;
  stage: "bonding" | "migrating" | "graduated"; creatorFeePct: number | null;
  creatorLifetimeLamports: string; creatorLast24hLamports: string; last24hWindowHours: number; creatorAvgPerDayLamports: string;
  claimableLamports: string; launchedAtMs: number; tailEligible: boolean; reasons: string[]; changedAtMs: number;
}
export interface FeeCoverage { mode: string; pools: number; configs: number; fullAtMs: number; deltaAtMs: number; fullEveryHours: number; deltaEveryMinutes: number }
export interface Launchpad { rank: number; launchpad: string; ours: boolean; coins: number; configs: number; graduated: number; tailEligibleCoins: number; creatorLifetimeLamports: string; creatorLast24hLamports: string; claimableLamports: string; creatorFeePct: number | null }
export interface OurConfig { config: string; launchpad: string | null; creatorFeePct: number | null; tailEligibleConfig: boolean | null; coins: number; graduated: number; creatorLifetimeLamports: string; creatorLast24hLamports: string; claimableLamports: string }
export const api = {
  feeCoins: (q: { sort: string; stage: string; eligible: boolean; creator?: string | null; q?: string; offset?: number; limit?: number }) => {
    const p = new URLSearchParams({ sort: q.sort, stage: q.stage, limit: String(q.limit ?? 50), offset: String(q.offset ?? 0) });
    if (q.eligible) p.set("eligible", "1"); if (q.creator) p.set("creator", q.creator); if (q.q) p.set("q", q.q);
    return get<{ coverage: FeeCoverage; coins: FeeCoin[]; offset: number; limit: number }>(`/api/fees/coins?${p}`);
  },
  feeLaunchpads: () => get<{ coverage: FeeCoverage; launchpads: Launchpad[]; ourConfigs: OurConfig[] }>("/api/fees/launchpads"),
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
