// A paired launch with a first buy paid in SOL takes two transactions: the first buys the $COMETAIL, the second
// creates the coin with exactly that first buy. What the first bought is kept only for the same wallet, the same
// config and the same SOL amount: a retry with all three spends it without buying again (and needs only the launch's
// own SOL costs); anything else buys its own, and the earlier $COMETAIL simply stays in the wallet.
export interface FirstBuyPurchase<T> { owner: string; config: string; solRaw: string; cometail: T }
export function pendingFirstBuy<T>(bought: FirstBuyPurchase<T> | null, owner: string | null, config: string | null, solRaw: bigint | null): FirstBuyPurchase<T> | null {
  if (!bought || !owner || !config || solRaw === null || solRaw <= 0n) return null;
  return bought.owner === owner && bought.config === config && bought.solRaw === solRaw.toString() ? bought : null;
}
/** SOL a paired launch still needs: the first buy only when its $COMETAIL is not already bought, plus the launch costs. */
export function launchSolNeed(paidInSol: boolean, firstBuyLamports: bigint | null, pending: boolean, overheadLamports: bigint): bigint {
  return (paidInSol && !pending ? firstBuyLamports ?? 0n : 0n) + overheadLamports;
}
