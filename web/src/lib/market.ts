"use client";
import { useEffect, useState , useRef } from "react";
import { API_URL, CLUSTER } from "./addresses";
import { WSOL, type QuoteUsd } from "./quotes";
import type { TokenLinks } from "./token-display";

export type MetricStatus = "ok" | "partial" | "stale" | "unavailable";
export interface MarketToken {
  links?: TokenLinks | null;
  mint: string; decimals: number; name: string | null; symbol: string | null;
  imageUrl: string | null; metadataStatus: "ok" | "missing" | "unreachable";
  creator: string; createdAtMs: number | null; dbcPool: string; dammPool: string | null;
  tokenKind: "plain" | "stream"; vault: string | null;
  stage: "bonding" | "completed" | "migrating" | "graduated";
  quoteMint: string; quoteDecimals: number | null; quoteUsd: QuoteUsd | null; priceQuote: string | null;
  priceSol: string | null; priceStatus?: MetricStatus; priceObservedAtMs?: number | null;
  liquidityLamports?: string | null; liquidityBasis?: "curve-quote-reserve" | "damm-quote-x2" | null;
  totalSupplyRaw: string | null; circulatingSupplyRaw: string | null;
  fdvUsd: string | null; marketCapUsd: string | null; valuationBasis: string;
  volume24hLamports: string | null; buys24h: number | null; sells24h: number | null;
  volumeStatus?: MetricStatus; windowStartMs: number | null; windowEndMs: number | null;
  coverageStartMs: number | null; complete: boolean;
  holders: { count: number | null; countedAtMs: number | null; status: MetricStatus; definition?: string } | null;
  progressBps: number | null; quoteRaisedLamports: string | null; targetLamports: string | null;
  migrationStage: "bonding" | "completed" | "migrating" | "graduated";
}
export interface MarketTrade {
  id: string; signature: string; ordinal: number; slot: number; blockTimeSec: number | null;
  pool: string; venue: "curve" | "damm"; side: "buy" | "sell";
  quoteMint: string; quoteDecimals: number; executionPriceQuote: string | null;
  baseAmountRaw: string | null; quoteAmountLamports: string | null; executionPriceSol: string | null;
  trader: string | null; traderKind: "authority" | "feePayer" | "unknown";
}
export interface MarketEnvelope<T> {
  schemaVersion: 1; cluster: string; generatedAtMs: number; observedSlot: number | null;
  coverage: { status: "complete" | "partial" | "stale"; pendingPools: number; lastSuccessfulAtMs: number | null };
  solUsd: { value: string | null; source: string; observedAtMs: number | null; status: MetricStatus } | null;
  data: T;
}
export interface TokenList { tokens: MarketToken[]; nextCursor: string | null; volumeRanking?: { basis: "quote-usd-v1"; unrated: "newest" } }
export interface TradeList { trades: MarketTrade[]; nextCursor: string | null }

/** Keep the worker's grouped wire schema separate from presentation fields. */
export function normalizeToken(value: unknown): MarketToken {
  if (!value || typeof value !== "object") throw new Error("Invalid token");
  const t = value as Record<string, any>;
  const i = t.identity, m = t.market, v = t.volume24h, b = t.bonding;
  if (!i || typeof i.mint !== "string" || !m || !v || !b) throw new Error("Invalid token");
  return {
    ...i, ...m, priceObservedAtMs: m.priceAtMs ?? null,
    quoteMint: m.quoteMint ?? i.quoteMint,
    quoteDecimals: m.quoteDecimals ?? (i.quoteMint === WSOL ? 9 : null),
    priceQuote: m.priceQuote ?? (i.quoteMint === WSOL ? m.priceSol : null),
    quoteUsd: m.quoteUsd ?? null,
    priceStatus: (m.priceQuote ?? (i.quoteMint === WSOL ? m.priceSol : null)) == null ? "unavailable" : "ok",
    volume24hLamports: v.lamports ?? null, buys24h: v.buys ?? null, sells24h: v.sells ?? null,
    volumeStatus: v.status === "complete" ? "ok" : v.status,
    windowStartMs: v.windowStartMs ?? null, windowEndMs: v.windowEndMs ?? null,
    coverageStartMs: v.coverageStartMs ?? null, complete: v.complete === true,
    holders: t.holders ? { ...t.holders, status: t.holders.status === "missing" ? "unavailable" : t.holders.status } : null,
    ...b,
  };
}

/** Visible-page polling, one request at a time; old responses cannot replace a new filter. */
export function useMarket<T>(path: string | null) {
  const [data, setData] = useState<MarketEnvelope<T> | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  // a token the indexer has not scanned yet answers 404: not an outage, a wait; polling continues faster
  const [notIndexed, setNotIndexed] = useState(false);
  const notIndexedRef = useRef(false);
  useEffect(() => { notIndexedRef.current = notIndexed; }, [notIndexed]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true, busy = false;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(null); setError(false); setNotIndexed(false); setLoading(!!path);
    if (!path) return;
    const load = async () => {
      if (!live || busy || document.visibilityState !== "visible") return;
      busy = true; controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 12000);
      try {
        const response = await fetch(`${API_URL}${path}`, { cache: "no-store", signal: controller.signal });
        if (response.status === 404 && /^\/api\/tokens\/[^/?]+/.test(path)) { if (live) { setNotIndexed(true); setError(false); } return; }
        if (!response.ok) throw new Error("Market read failed");
        if (live) setNotIndexed(false);
        const next = await response.json() as MarketEnvelope<T>;
        if (next.schemaVersion !== 1 || next.cluster !== CLUSTER || !next.coverage || !next.data) throw new Error("Market response is unavailable");
        const payload = next.data as Record<string, unknown>;
        if (path.startsWith("/api/tokens?")) {
          if (!Array.isArray(payload.tokens)) throw new Error("Invalid token list");
          payload.tokens = payload.tokens.map(normalizeToken);
        } else if (path.includes("/trades?")) {
          if (!Array.isArray(payload.trades) || !payload.trades.every(t => t && typeof t.id === "string" && typeof t.signature === "string")) throw new Error("Invalid trade list");
        } else next.data = normalizeToken(payload) as T;
        if (next.solUsd) {
          next.solUsd.value = next.solUsd.value === null ? null : String(next.solUsd.value);
          if (String(next.solUsd.status) === "fresh") next.solUsd.status = "ok";
        }
        if (live) { setData(next); setError(false); }
      } catch { if (live && document.visibilityState === "visible") { setError(true); setNotIndexed(false); } }
      finally {
        clearTimeout(timeout); busy = false;
        if (live) { setLoading(false); clearTimeout(timer); timer = setTimeout(load, notIndexedRef.current ? 12000 : 20000); }
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") void load(); else controller?.abort();
    };
    void load(); document.addEventListener("visibilitychange", visibility);
    return () => { live = false; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, [path, tick]);
  return { data, loading, error, notIndexed, reload: () => setTick(t => t + 1) };
}

export function rawUnits(raw: string | null | undefined, decimals: number): string | null {
  if (!raw || !/^\d+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) return null;
  const padded = raw.padStart(decimals + 1, "0");
  return decimals ? `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}` : padded;
}
export function marketNumber(value: string | number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n > 0 && n < 10 ** -digits) return `<${(10 ** -digits).toFixed(digits)}`;
  return new Intl.NumberFormat("en", { maximumFractionDigits: digits, notation: n >= 1e6 ? "compact" : "standard" }).format(n);
}
export function marketTime(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(ms) + " UTC";
}
