import { ADDRESSES, CLUSTER } from "./addresses";
import { missingRate, PRICE_MAX_AGE_MS, type SolUsdRate } from "./usd";

export interface QuoteAsset { mint: string | null; decimals: number | null; symbol: string }
export interface QuoteUsd { value: number | null; source: string | null; status: "fresh" | "stale" | "missing" }
export const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** An unknown mint never inherits SOL units or decimals. */
export function quoteAsset(mint: string | null | undefined, decimals?: number | null, symbol?: string | null): QuoteAsset {
  const native = mint === WSOL;
  const usdc = mint === USDC || !!mint && mint === ADDRESSES.quoteMints.usdc?.toBase58();
  const stock = !!mint && mint === ADDRESSES.quoteMints.stock?.toBase58();
  const knownDecimals = native ? 9 : usdc ? 6 : stock ? 8 : null;
  const validDecimals = typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 && decimals <= 30;
  const label = native ? "SOL" : usdc ? (CLUSTER === "devnet" && mint !== USDC ? "test USDC" : "USDC") : stock ? (CLUSTER === "devnet" ? "test stock" : "stock units") : mint ? `${mint.slice(0,4)}…${mint.slice(-4)}` : "quote tokens";
  return { mint: mint ?? null, decimals: validDecimals ? decimals : knownDecimals, symbol: symbol?.trim() || label };
}
export function quoteRate(rate: QuoteUsd | null | undefined, observedAt: number | null | undefined): SolUsdRate {
  if (!rate || rate.status === "missing" || typeof rate.value !== "number" || !Number.isFinite(rate.value) || rate.value <= 0 || !observedAt || observedAt > Date.now() + 60_000) return missingRate;
  return { value: rate.value, source: rate.source, at: observedAt, status: rate.status === "fresh" && Date.now() - observedAt < PRICE_MAX_AGE_MS ? "fresh" : "stale" };
}
