import BN from "bn.js";

const LAMPORTS = 1_000_000_000;
export const sol = (lamports: BN | bigint | number | string, digits = 4): string => {
  const n = Number(typeof lamports === "object" && "toString" in lamports ? lamports.toString() : lamports) / LAMPORTS;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: digits })} SOL`;
};
export const units = (raw: BN | bigint | number | string, decimals: number, digits = 2): string => {
  const n = Number(typeof raw === "object" && "toString" in raw ? raw.toString() : raw) / 10 ** decimals;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
};
export const short = (key: string, n = 4): string => `${key.slice(0, n)}…${key.slice(-n)}`;
export const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
export const ago = (unix: number | null): string => {
  if (!unix) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
