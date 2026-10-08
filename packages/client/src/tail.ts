// Tails: a coin $tX launched by the owner's own wallet on a fee-sale config and pointed at an existing coin $X.
// No program is involved. The owner claims the tail's creator curve fees and, in the same transaction, splits
// them by hand: half stays in the claiming wallet, a quarter goes to the burn reserve (which can only buy and
// burn $COMETAIL), and a quarter becomes liquidity in $X's compounding DAMM v2 pool, in a position the wallet
// holds, permanently locked in the same transaction. The split is ours, done in the open, not forced by code.
//
// Pure: no RPC, no signing. The caller reads the pools and passes their state; every amount is computed here
// from that state, so the page, the tests and the indexer agree on the numbers.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID } from "./ids";

const DBC_POOL_AUTHORITY = new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
const DAMM_POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
const DBC_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DBC_PROGRAM_ID)[0];
const DAMM_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DAMM_V2_PROGRAM_ID)[0];

/** Instruction discriminators (idls/dynamic_bonding_curve.json, idls/cp_amm.json). */
const DISC = {
  claimCreatorTradingFee: [82, 220, 250, 189, 3, 85, 107, 45],
  withdrawMigrationFee: [237, 142, 45, 23, 129, 6, 222, 162],
  creatorWithdrawSurplus: [165, 3, 137, 7, 28, 134, 76, 80],
  swap: [248, 198, 158, 145, 225, 117, 135, 200],
  addLiquidity: [181, 157, 89, 67, 143, 182, 52, 72],
  permanentLockPosition: [165, 176, 125, 6, 231, 171, 186, 213],
  createPosition: [48, 215, 197, 153, 96, 203, 180, 133],
} as const;

/** DAMM v2: fee precision, compounding collect mode, the pool's enabled status. */
const FEE_DENOMINATOR = 1_000_000_000n;
const COLLECT_COMPOUNDING = 2;
const POOL_ENABLED = 0;
/** Default swap tolerance, and the margin the liquidity delta keeps below the predicted maximum (basis points). */
export const TAIL_SLIPPAGE_BPS = 100;
export const TAIL_LIQUIDITY_MARGIN_BPS = 20;

// little-endian by hand: the browser's Buffer polyfill has no 64-bit readers or writers
const le = (v: bigint, bytes: number) => { const b = Buffer.alloc(bytes); for (let i = 0; i < bytes; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const u64 = (v: bigint) => le(v, 8);
const u128 = (v: bigint) => le(v, 16);
const readU64 = (b: Uint8Array, o: number) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; };
const data = (disc: readonly number[], ...parts: Buffer[]) => Buffer.concat([Buffer.from(disc), ...parts]);
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

export function derivePosition(nftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("position"), nftMint.toBuffer()], DAMM_V2_PROGRAM_ID)[0];
}
export function derivePositionNftAccount(nftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("position_nft_account"), nftMint.toBuffer()], DAMM_V2_PROGRAM_ID)[0];
}

/** How a claim of `claimed` lamports is split: half kept, a quarter to the burn reserve, a quarter to liquidity.
 *  Rounding leaves the odd lamports with the wallet. */
export function tailSplit(claimed: bigint) {
  const toBurn = claimed / 4n;
  const toLiquidity = claimed / 4n;
  return { claimed, kept: claimed - toBurn - toLiquidity, toBurn, toLiquidity };
}

/** The state of $X's pool that the split needs (a compounding SOL pool: $X is token A, SOL token B). */
export type CompoundingPool = {
  pool: PublicKey; tokenAMint: PublicKey; tokenAVault: PublicKey; tokenBVault: PublicKey; tokenAProgram: PublicKey;
  tokenAAmount: bigint; tokenBAmount: bigint; liquidity: bigint;
  feeNumerator: bigint; protocolFeePercent: bigint; compoundingFeeBps: bigint;
};

/** Reads a decoded DAMM v2 pool (cp-amm SDK or Anchor coder field names) into a CompoundingPool, refusing any pool
 *  the math here does not describe: not compounding, not enabled, not paired with SOL as token B, a dynamic fee,
 *  or a base fee that is not a constant cliff (scheduler periods or a rate limiter). */
export function compoundingPool(pool: PublicKey, p: any, tokenAProgram: PublicKey = TOKEN_PROGRAM_ID): CompoundingPool {
  const n = (v: any) => BigInt(v.toString());
  if (Number(p.collectFeeMode) !== COLLECT_COMPOUNDING) throw new Error("pool is not a compounding pool");
  if (Number(p.poolStatus) !== POOL_ENABLED) throw new Error("pool is not enabled");
  if (!new PublicKey(p.tokenBMint).equals(NATIVE_MINT)) throw new Error("pool is not paired with SOL as token B");
  if (Number(p.poolFees.dynamicFee.initialized) !== 0) throw new Error("pool has a dynamic fee");
  const info = Uint8Array.from(p.poolFees.baseFee.baseFeeInfo.data as number[]);
  if (info.length !== 32 || info.subarray(8).some((b) => b !== 0)) throw new Error("pool fee is not constant");
  return {
    pool, tokenAMint: new PublicKey(p.tokenAMint), tokenAVault: new PublicKey(p.tokenAVault), tokenBVault: new PublicKey(p.tokenBVault), tokenAProgram,
    tokenAAmount: n(p.tokenAAmount), tokenBAmount: n(p.tokenBAmount), liquidity: n(p.liquidity),
    feeNumerator: readU64(info, 0), protocolFeePercent: n(p.poolFees.protocolFeePercent), compoundingFeeBps: n(p.poolFees.compoundingFeeBps),
  };
}

/** A SOL -> $X swap on a compounding pool, as cp-amm computes it: the fee is taken from the SOL input (rounded up),
 *  the output is constant product on the reserves (rounded down), and the compounding share of the LP fee is added
 *  to the SOL reserve. Returns the output and the reserves after the swap. */
export function quoteBuy(p: CompoundingPool, amountIn: bigint) {
  const fee = (amountIn * p.feeNumerator + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR;
  const net = amountIn - fee;
  const out = (p.tokenAAmount * net) / (p.tokenBAmount + net);
  const lpFee = fee - (fee * p.protocolFeePercent) / 100n;
  const compounding = (lpFee * p.compoundingFeeBps) / 10_000n;
  return { out, fee, tokenAAfter: p.tokenAAmount - out, tokenBAfter: p.tokenBAmount + net + compounding };
}

/** The liquidity two amounts buy in a compounding pool (cp-amm deposits ceil(delta * reserve / liquidity) of each). */
export function liquidityFor(amountA: bigint, amountB: bigint, tokenA: bigint, tokenB: bigint, liquidity: bigint): bigint {
  const fromA = (amountA * liquidity) / tokenA, fromB = (amountB * liquidity) / tokenB;
  return fromA < fromB ? fromA : fromB;
}

/** How much of the liquidity quarter to swap into $X so that both sides deposit fully: a little over half for a
 *  claim small next to the pool (the swap pays the pool fee), below half when the claim moves the price. Found by bisection on the exact quote; returns the
 *  swap, its output and the liquidity both sides cover at the reserves after the swap. */
export function liquidityPlan(p: CompoundingPool, total: bigint) {
  const at = (swapIn: bigint) => {
    const q = quoteBuy(p, swapIn);
    const fromA = (q.out * p.liquidity) / q.tokenAAfter, fromB = ((total - swapIn) * p.liquidity) / q.tokenBAfter;
    return { swapIn, q, fromA, fromB, delta: fromA < fromB ? fromA : fromB };
  };
  // fromA grows with the swap (more $X out, a smaller $X reserve) and fromB shrinks (less SOL left, a larger SOL
  // reserve): the best swap is where they cross, anywhere in [0, total]. Price impact can put it below half.
  let lo = 0n, hi = total;
  while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (at(mid).fromA < at(mid).fromB) lo = mid; else hi = mid; }
  const a = at(lo), b = at(hi);
  return a.delta >= b.delta ? a : b;
}

export type TailCurve = { pool: PublicKey; baseMint: PublicKey; baseVault: PublicKey; quoteVault: PublicKey; baseTokenProgram?: PublicKey };
export type LockedPosition = { position: PublicKey; nftAccount: PublicKey };

/** One-time setup: the wallet's position in $X's pool (its NFT mint signs as a new account) and the token
 *  accounts the claim uses. Rent is paid by the wallet. */
export function createLockedPositionIxs(a: { owner: PublicKey; pool: PublicKey; nftMint: PublicKey; tokenAMint: PublicKey; tokenAProgram?: PublicKey; tailMint: PublicKey; tailTokenProgram?: PublicKey }) {
  const position = derivePosition(a.nftMint), nftAccount = derivePositionNftAccount(a.nftMint);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(a.owner, getAssociatedTokenAddressSync(NATIVE_MINT, a.owner), a.owner, NATIVE_MINT),
    createAssociatedTokenAccountIdempotentInstruction(a.owner, getAssociatedTokenAddressSync(a.tokenAMint, a.owner, false, a.tokenAProgram ?? TOKEN_PROGRAM_ID), a.owner, a.tokenAMint, a.tokenAProgram ?? TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(a.owner, getAssociatedTokenAddressSync(a.tailMint, a.owner, false, a.tailTokenProgram ?? TOKEN_PROGRAM_ID), a.owner, a.tailMint, a.tailTokenProgram ?? TOKEN_PROGRAM_ID),
    new TransactionInstruction({
      programId: DAMM_V2_PROGRAM_ID,
      keys: [meta(a.owner), meta(a.nftMint, true, true), meta(nftAccount, true), meta(a.pool, true), meta(position, true), meta(DAMM_POOL_AUTHORITY), meta(a.owner, true, true),
        meta(TOKEN_2022_PROGRAM_ID), meta(SystemProgram.programId), meta(DAMM_EVENT_AUTHORITY), meta(DAMM_V2_PROGRAM_ID)],
      data: data(DISC.createPosition),
    }),
  ];
  return { ixs, position, nftAccount };
}

/** The claim and its split, in one transaction signed by the tail's creator:
 *   1. DBC claim_creator_trading_fee of exactly `claimable` lamports (what the pool owed when it was read);
 *   2. a quarter transferred to the burn reserve;
 *   3. a little over half of the liquidity quarter swapped into $X on its pool (liquidityPlan), with a minimum out
 *      from the pool state just read;
 *   4. that $X and the rest of the quarter added to the wallet's position as liquidity;
 *   5. exactly the added liquidity permanently locked.
 *  The rest (half, plus rounding and any dust the liquidity margin leaves) stays in the wallet. */
export function tailClaimIxs(a: {
  creator: PublicKey; curve: TailCurve; claimable: bigint; reserve: PublicKey; x: CompoundingPool; locked: LockedPosition;
  slippageBps?: number; marginBps?: number;
}) {
  const split = tailSplit(a.claimable);
  const slippage = BigInt(a.slippageBps ?? TAIL_SLIPPAGE_BPS), margin = BigInt(a.marginBps ?? TAIL_LIQUIDITY_MARGIN_BPS);
  if (split.toLiquidity < 4n) throw new Error("claim too small to split");
  const plan = liquidityPlan(a.x, split.toLiquidity);
  const swapIn = plan.swapIn, liquiditySol = split.toLiquidity - swapIn, out = plan.q.out;
  const minOut = (out * (10_000n - slippage)) / 10_000n;
  if (minOut <= 0n) throw new Error("swap would return nothing");
  // sized from the expected output at the reserves just read, less a small margin for rounding; a trade landing
  // first changes both and the transaction fails as a whole (nothing moves), to be built again from fresh state
  const liquidityDelta = (plan.delta * (10_000n - margin)) / 10_000n - 1n;
  if (liquidityDelta <= 0n) throw new Error("liquidity too small to add");
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, a.creator);
  const baseProgram = a.curve.baseTokenProgram ?? TOKEN_PROGRAM_ID;
  const tailAta = getAssociatedTokenAddressSync(a.curve.baseMint, a.creator, false, baseProgram);
  const xAta = getAssociatedTokenAddressSync(a.x.tokenAMint, a.creator, false, a.x.tokenAProgram);
  const ixs = [
    new TransactionInstruction({
      programId: DBC_PROGRAM_ID,
      keys: [meta(DBC_POOL_AUTHORITY), meta(a.curve.pool, true), meta(tailAta, true), meta(wsol, true), meta(a.curve.baseVault, true), meta(a.curve.quoteVault, true),
        meta(a.curve.baseMint), meta(NATIVE_MINT), meta(a.creator, false, true), meta(baseProgram), meta(TOKEN_PROGRAM_ID), meta(DBC_EVENT_AUTHORITY), meta(DBC_PROGRAM_ID)],
      data: data(DISC.claimCreatorTradingFee, u64(0n), u64(a.claimable)),
    }),
    createTransferInstruction(wsol, a.reserve, a.creator, split.toBurn),
    new TransactionInstruction({
      programId: DAMM_V2_PROGRAM_ID,
      keys: [meta(DAMM_POOL_AUTHORITY), meta(a.x.pool, true), meta(wsol, true), meta(xAta, true), meta(a.x.tokenAVault, true), meta(a.x.tokenBVault, true),
        meta(a.x.tokenAMint), meta(NATIVE_MINT), meta(a.creator, false, true), meta(a.x.tokenAProgram), meta(TOKEN_PROGRAM_ID),
        meta(DAMM_V2_PROGRAM_ID), meta(DAMM_EVENT_AUTHORITY), meta(DAMM_V2_PROGRAM_ID)],
      data: data(DISC.swap, u64(swapIn), u64(minOut)),
    }),
    new TransactionInstruction({
      programId: DAMM_V2_PROGRAM_ID,
      keys: [meta(a.x.pool, true), meta(a.locked.position, true), meta(xAta, true), meta(wsol, true), meta(a.x.tokenAVault, true), meta(a.x.tokenBVault, true),
        meta(a.x.tokenAMint), meta(NATIVE_MINT), meta(a.locked.nftAccount), meta(a.creator, false, true), meta(a.x.tokenAProgram), meta(TOKEN_PROGRAM_ID),
        meta(DAMM_EVENT_AUTHORITY), meta(DAMM_V2_PROGRAM_ID)],
      data: data(DISC.addLiquidity, u128(liquidityDelta), u64(out), u64(liquiditySol)),
    }),
    new TransactionInstruction({
      programId: DAMM_V2_PROGRAM_ID,
      keys: [meta(a.x.pool, true), meta(a.locked.position, true), meta(a.locked.nftAccount), meta(a.creator, false, true), meta(DAMM_EVENT_AUTHORITY), meta(DAMM_V2_PROGRAM_ID)],
      data: data(DISC.permanentLockPosition, u128(liquidityDelta)),
    }),
  ];
  return { ixs, split: { ...split, swapIn, liquiditySol }, minOut, expectedOut: out, liquidityDelta };
}

/** The graduation payout to the tail's creator: DBC's creator migration fee and creator surplus, to the wallet. */
export function tailCashoutIxs(a: { creator: PublicKey; config: PublicKey; curve: TailCurve; migrationFeePending: boolean; surplusPending: boolean }) {
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, a.creator);
  const keys = (signerName: PublicKey) => [meta(DBC_POOL_AUTHORITY), meta(a.config), meta(a.curve.pool, true), meta(wsol, true), meta(a.curve.quoteVault, true), meta(NATIVE_MINT),
    meta(signerName, false, true), meta(TOKEN_PROGRAM_ID), meta(DBC_EVENT_AUTHORITY), meta(DBC_PROGRAM_ID)];
  const ixs: TransactionInstruction[] = [createAssociatedTokenAccountIdempotentInstruction(a.creator, wsol, a.creator, NATIVE_MINT)];
  if (a.migrationFeePending) ixs.push(new TransactionInstruction({ programId: DBC_PROGRAM_ID, keys: keys(a.creator), data: data(DISC.withdrawMigrationFee, Buffer.from([1])) }));
  if (a.surplusPending) ixs.push(new TransactionInstruction({ programId: DBC_PROGRAM_ID, keys: keys(a.creator), data: data(DISC.creatorWithdrawSurplus) }));
  return ixs;
}
