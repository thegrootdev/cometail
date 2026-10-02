// Ladder construction. The program enforces side, ascending ids, the bin bound, the period
// budget and the order cap (ladder.rs route); this only chooses bins and sizes inside them.
//
// Stream token as X: income is token Y (WSOL), bids rest below the active bin, ids <= bin_bound.
// Stream token as Y: income is token X (WSOL), asks rest above the active bin, ids >= bin_bound.
// The ladder spans a band of price distance from the market (2% to 20% by default, in bins
// of the pair's bin step); nearest bins carry the most weight (geometric decay).

export interface LadderInput {
  activeId: number;
  stIsX: boolean;
  binBound: number;
  budget: bigint;
  bins: number;
  decay: number;
  /** Offsets in bins from the active bin: the band the ladder spans (near >= 1, far >= near). */
  nearOffset: number;
  farOffset: number;
}

export interface LadderBin { id: number; amount: bigint }

/** Bins that span `spreadBps` of price at a given bin step, at least 1. */
export function binsForSpread(spreadBps: number, binStep: number): number {
  if (binStep <= 0) return 1;
  const n = Math.log(1 + spreadBps / 10_000) / Math.log(1 + binStep / 10_000);
  return Math.max(1, Math.min(50, Math.floor(n)));
}

export function buildLadder(i: LadderInput): LadderBin[] {
  const n = Math.max(1, Math.min(50, i.bins));
  // n offsets spread evenly across [near, far], then the bins outside the cap are dropped
  const near = Math.max(1, Math.floor(i.nearOffset));
  const far = Math.max(near, Math.floor(i.farOffset));
  const offsets = new Set<number>();
  for (let k = 0; k < n; k++) offsets.add(n === 1 ? near : Math.round(near + ((far - near) * k) / (n - 1)));
  const ids: number[] = [];
  for (const off of [...offsets].sort((a, b) => a - b)) {
    const id = i.stIsX ? i.activeId - off : i.activeId + off;
    if (i.stIsX ? id <= i.binBound : id >= i.binBound) ids.push(id);
  }
  if (ids.length === 0) return [];
  if (i.budget <= 0n) return [];
  // weights: decay^0 for the nearest, decay^(k-1) for the k-th
  const scale = 1_000_000n;
  const weights = ids.map((_, k) => BigInt(Math.round(Math.pow(i.decay, k) * Number(scale))));
  const total = weights.reduce((a, b) => a + b, 0n);
  let left = i.budget;
  const out: LadderBin[] = [];
  ids.forEach((id, k) => {
    const amount = k === ids.length - 1 ? left : (i.budget * weights[k]) / total;
    left -= amount;
    if (amount > 0n) out.push({ id, amount });
  });
  // the program requires strictly ascending ids
  out.sort((a, b) => a.id - b.id);
  return out;
}

/** Crossed bins per ladder.rs settle: a bid above the active bin or an ask below it. */
export function isCrossed(binId: number, isAsk: boolean, activeId: number): boolean {
  return isAsk ? binId < activeId : binId > activeId;
}
