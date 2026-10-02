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
