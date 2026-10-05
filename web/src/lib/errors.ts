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
  if (/tooearly|unwind window/.test(m)) return failures.unwindTooEarly;
  if (/notunwindable|graduates instead/.test(m)) return failures.unwindGraduated;
  if (/registerpositionfirst|register its creator position/.test(m)) return failures.registerPositionFirst;
  if (/insufficient liquidity|slippage|exceeds desired|price impact/.test(m)) return failures.quoteFailed;
  if (/uri too long/.test(m)) return failures.uriTooLong;
  if (/name too long|symbol too long/.test(m)) return failures.identityTooLong;
  return fallback;
}

/** The plainest line a failed simulation offers: an Anchor error message, a program's own log line
 *  that names the problem, or the error code; empty when nothing readable is there. */
export function simulationReason(err: unknown, logs: string[] = []): string {
  const anchor = logs.map((l) => /Error Message: (.+?)\.?$/.exec(l)?.[1]).find(Boolean);
  if (anchor) return anchor;
  const named = logs.map((l) => /^Program log: (.*(?:too long|not allowed|invalid|insufficient|mismatch|not initialized|expired|exceed|overflow|unauthorized|ineligible|wrong|missing).*)$/i.exec(l)?.[1]).find(Boolean);
  if (named) return named.slice(0, 160);
  const custom = logs.map((l) => /custom program error: (0x[0-9a-f]+)/i.exec(l)?.[1]).find(Boolean);
  if (custom) return `program error ${custom}`;
  const text = typeof err === "string" ? err : err ? JSON.stringify(err) : "";
  return text.slice(0, 160);
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

/** The sentence shown before a wallet prompt when the wallet holds fewer tokens than the sell. */
export function insufficientTokens(needText: string, haveText: string): string {
  return `This sell needs ${needText}, and this wallet holds ${haveText}. Lower the amount and try again.`;
}
