// Display conversions only. Transaction amounts remain in their original units.
export const PRICE_MAX_AGE_MS = 10 * 60_000;
export type PriceStatus = "fresh" | "stale" | "missing";
export interface SolUsdRate {
  value: number | null;
  source: string | null;
  at: number | null;
  status: PriceStatus;
}
export const missingRate: SolUsdRate = { value: null, source: null, at: null, status: "missing" };
export function parseRate(input: unknown, now = Date.now()): SolUsdRate {
  const p = input as { solUsd?: unknown; source?: unknown; at?: unknown } | null;
  if (!p || typeof p.solUsd !== "number" || !Number.isFinite(p.solUsd) || p.solUsd <= 0 ||
    typeof p.at !== "number" || !Number.isFinite(p.at) || p.at <= 0 || p.at > now + 60_000 ||
    typeof p.source !== "string" || !p.source.trim()) return missingRate;
  return { value: p.solUsd, source: p.source, at: p.at, status: now - p.at < PRICE_MAX_AGE_MS ? "fresh" : "stale" };
}
export function usdValue(sol: string | number | null | undefined, rate: SolUsdRate): number | null {
  if (rate.status !== "fresh" || rate.value === null || sol === null || sol === undefined || sol === "") return null;
  const n = Number(sol), usd = n * rate.value;
  return Number.isFinite(n) && n >= 0 && Number.isFinite(usd) ? usd : null;
}
export function formatUsd(value: number | null, price = false): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "—";
  const digits = price && value < 1 ? 6 : 2;
  if (value > 0 && value < 10 ** -digits) return `<$${(10 ** -digits).toFixed(digits)}`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits,
    minimumFractionDigits: price ? 0 : 2, notation: value >= 1e6 ? "compact" : "standard" }).format(value);
}
