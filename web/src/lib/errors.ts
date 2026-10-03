// Every failure the user sees is designed copy. Raw messages go to the console for whoever is
// debugging; the page gets a sentence that says what happened and what to do next.
import { failures } from "@/content/cometail";

/** An error whose message is already designed copy (our own validation, the upload route's answers). */
export class DesignedError extends Error {
  readonly designed = true;
}

export function friendlyError(e: unknown, fallback: string = failures.actionFailed): string {
  if (e && typeof e === "object" && (e as DesignedError).designed) return (e as Error).message;
  const raw = e instanceof Error ? e.message : String(e ?? "");
  if (typeof console !== "undefined") console.warn("cometail: failure", raw);
  const m = raw.toLowerCase();
  if (/not valid json|unexpected token|<!doctype|unexpected end of json|failed to fetch|networkerror|load failed/.test(m)) return failures.serviceBadResponse;
  if (/user rejected|rejected the request|user denied|cancelled by user|canceled by user|declined/.test(m)) return failures.walletRejected;
  if (/insufficient lamports|insufficient funds|attempt to debit|custom program error: 0x1\b|not enough sol/.test(m)) return failures.notEnoughSol;
  if (/blockhash|block height exceeded|expired|timed out|timeout|was not confirmed/.test(m)) return failures.txExpired;
  if (/429|rate limit|too many requests|server responded with/.test(m)) return failures.busy;
  if (/insufficient liquidity|slippage|exceeds desired|price impact/.test(m)) return failures.quoteFailed;
  return fallback;
}

/** Creation fee, mint and metadata rent and network fees of a plain launch, beyond the first buy. */
export const LAUNCH_OVERHEAD_LAMPORTS = 35_000_000n;
const trimZeros = (s: string) => s.replace(/\.?0+$/, "");
/** Lamports as SOL with up to four decimals, rounded down (a balance is never overstated). */
const solText = (lamports: bigint) => trimZeros((lamports / 100_000n).toString().padStart(5, "0").replace(/(\d{4})$/, ".$1"));
/** Lamports as SOL rounded up to the next 0.001 SOL, so the amount named always covers the shortfall. */
const solTextUp = (lamports: bigint) => { const thousandths = (lamports + 999_999n) / 1_000_000n; return trimZeros(thousandths.toString().padStart(4, "0").replace(/(\d{3})$/, ".$1")); };
/** The sentence shown before a wallet prompt when the balance cannot cover the action. */
export function insufficientSol(needLamports: bigint, haveLamports: bigint): string {
  const short = needLamports > haveLamports ? needLamports - haveLamports : 0n;
  return `This needs about ${solText(needLamports)} SOL including fees, and this wallet holds ${solText(haveLamports)} SOL. Add at least ${solTextUp(short)} SOL and try again.`;
}
