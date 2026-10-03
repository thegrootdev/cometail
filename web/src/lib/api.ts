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
export const api = {
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
