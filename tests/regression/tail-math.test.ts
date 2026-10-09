// The liquidity plan of a tail claim (packages/client/src/tail.ts): the swap size where both sides of
// the add deposit fully, for claims tiny next to the pool through claims larger than its reserves, checked against a
// brute-force search; after the 0.2% margin, what stays in the wallet is the margin and rounding, on both sides.
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { liquidityPlan, quoteBuy, type CompoundingPool } from "@cometail/client";

const pool = (a: bigint, b: bigint, l: bigint): CompoundingPool => ({ pool: PublicKey.default, tokenAMint: PublicKey.default, tokenAVault: PublicKey.default, tokenBVault: PublicKey.default, tokenAProgram: PublicKey.default, tokenAAmount: a, tokenBAmount: b, liquidity: l, feeNumerator: 10_000_000n, protocolFeePercent: 20n, compoundingFeeBps: 5_000n });
const deltaAt = (p: CompoundingPool, total: bigint, s: bigint) => { const q = quoteBuy(p, s); const fa = (q.out * p.liquidity) / q.tokenAAfter, fb = ((total - s) * p.liquidity) / q.tokenBAfter; return fa < fb ? fa : fb; };
/** Brute force: a coarse grid over [0, total], then every unit around the best grid point. */
function oracle(p: CompoundingPool, total: bigint) {
  let best = 0n, at = 0n;
  const steps = 2000n, step = total / steps > 0n ? total / steps : 1n;
  for (let s = 0n; s <= total; s += step) { const d = deltaAt(p, total, s); if (d > best) { best = d; at = s; } }
  for (let s = at > step ? at - step : 0n; s <= at + step && s <= total; s++) { const d = deltaAt(p, total, s); if (d > best) best = d; if (step > 5_000n) s += step / 5_000n; }
  return best;
}

describe("tail liquidity plan", () => {
  const cases: [string, CompoundingPool, bigint][] = [
    ["the large-claim fixture: a claim equal to the pool's SOL", pool(1_000_000_000_000n, 1_000_000_000n, 100_000_000_000_000_000_000n), 1_000_000_000n],
    ["tiny claim", pool(1_000_000_000_000n, 30_000_000_000n, 10n ** 24n), 50_000n],
    ["1% of the pool", pool(500_000_000_000_000n, 40_000_000_000n, 10n ** 27n), 400_000_000n],
    ["10% of the pool", pool(500_000_000_000_000n, 40_000_000_000n, 10n ** 27n), 4_000_000_000n],
    ["five times the pool", pool(2_000_000_000_000n, 2_000_000_000n, 10n ** 22n), 10_000_000_000n],
  ];
  for (const [name, p, total] of cases) it(name, () => {
    const plan = liquidityPlan(p, total);
    const best = oracle(p, total);
    // the plan is the best swap (to a part in a million of the liquidity, the integer rounding)
    expect(Number(best - plan.delta) / Number(best)).lte(1e-6);
    // after the margin the builder applies, both sides deposit all but the margin and rounding
    const delta = (plan.delta * 9_980n) / 10_000n - 1n;
    const depA = (delta * plan.q.tokenAAfter + p.liquidity - 1n) / p.liquidity, depB = (delta * plan.q.tokenBAfter + p.liquidity - 1n) / p.liquidity;
    const leftA = Number(plan.q.out - depA) / Number(plan.q.out), leftB = Number(total - plan.swapIn - depB) / Number(total - plan.swapIn);
    expect(depA <= plan.q.out && depB <= total - plan.swapIn).true;
    expect(leftA, `$X left ${leftA}`).lte(0.0021);
    expect(leftB, `SOL left ${leftB}`).lte(0.0021);
  });
  it("the large-claim fixture swaps below half: the optimum moved with price impact", () => {
    const [, p, total] = cases[0];
    expect(liquidityPlan(p, total).swapIn < total / 2n).true;
  });
});
