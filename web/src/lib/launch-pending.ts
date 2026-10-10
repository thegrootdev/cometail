// A paired launch with a first buy paid in SOL takes two transactions: the first buys the $COMETAIL, the second
// creates the coin with exactly that first buy. What the first bought is kept only for the same wallet, the same
// config and the same SOL amount: a retry with all three spends it without buying again (and needs only the launch's
// own SOL costs); anything else buys its own, and the earlier $COMETAIL simply stays in the wallet.
//
// The first transaction's identity (signature, blockhash) is recorded before it is sent. Until its outcome is known it
// is unsettled, and nothing buys $COMETAIL again for that wallet: only the chain settles it (a confirmed or finalized
// status, or a blockhash that expired with the transaction never seen), never a balance read.
import type { Connection } from "@solana/web3.js";

export interface FirstBuyPurchase<T> {
  owner: string; config: string; solRaw: string; cometail: T;
  signature: string; blockhash: string; lastValidBlockHeight: number | null;
  /** true once the chain confirmed the purchase landed */
  settled: boolean;
}
/** The purchase made for this wallet, config and amount, settled or not (the caller settles it before spending it). */
export function pendingFirstBuy<T>(bought: FirstBuyPurchase<T> | null, owner: string | null, config: string | null, solRaw: bigint | null): FirstBuyPurchase<T> | null {
  if (!bought || !owner || !config || solRaw === null || solRaw <= 0n) return null;
  return bought.owner === owner && bought.config === config && bought.solRaw === solRaw.toString() ? bought : null;
}
/** SOL a paired launch still needs: the first buy only when its $COMETAIL is not already bought, plus the launch costs. */
export function launchSolNeed(paidInSol: boolean, firstBuyLamports: bigint | null, pending: boolean, overheadLamports: bigint): bigint {
  return (paidInSol && !pending ? firstBuyLamports ?? 0n : 0n) + overheadLamports;
}

export type FirstBuyOutcome = "landed" | "none" | "pending" | "unknown";
type Chain = Pick<Connection, "getSignatureStatuses" | "getBlockHeight" | "isBlockhashValid">;
/** The first transaction's outcome, from the chain only: landed or failed once confirmed (or finalized); never landing
 *  once its blockhash expired unseen; otherwise pending (sent, or seen only at processed); unknown when the RPC fails. */
export async function settleFirstBuy(connection: Chain, b: Pick<FirstBuyPurchase<unknown>, "signature" | "blockhash" | "lastValidBlockHeight">): Promise<FirstBuyOutcome> {
  const status = async () => (await connection.getSignatureStatuses([b.signature], { searchTransactionHistory: true })).value[0];
  try {
    const s = await status();
    const confirmed = !!s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized");
    if (s && confirmed) return s.err === null ? "landed" : "none";
    if (s) return "pending"; // processed (or no level given): it may still change
    const expired = b.lastValidBlockHeight != null
      ? (await connection.getBlockHeight("confirmed")) > b.lastValidBlockHeight
      : !(await connection.isBlockhashValid(b.blockhash, { commitment: "confirmed" })).value;
    if (!expired) return "pending";
    // expired: one more look, then it can never land
    const last = await status();
    if (!last) return "none";
    const lastConfirmed = last.confirmationStatus === "confirmed" || last.confirmationStatus === "finalized";
    return lastConfirmed ? (last.err === null ? "landed" : "none") : "pending";
  } catch {
    return "unknown";
  }
}

/** The record kept in the browser across a reload, per wallet (the amount as a decimal string). */
const key = (owner: string) => `cometail:paired-first-buy:${owner}`;
export function loadFirstBuy(owner: string): FirstBuyPurchase<string> | null {
  try {
    const raw = window.localStorage.getItem(key(owner));
    const r = raw ? JSON.parse(raw) : null;
    return r && r.owner === owner && typeof r.signature === "string" && typeof r.cometail === "string" ? r : null;
  } catch {
    return null;
  }
}
export function saveFirstBuy(owner: string, r: FirstBuyPurchase<string> | null): void {
  try {
    if (r) window.localStorage.setItem(key(owner), JSON.stringify(r));
    else window.localStorage.removeItem(key(owner));
  } catch {
    // no storage: the record lives only as long as the page
  }
}
