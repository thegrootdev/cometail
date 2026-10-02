// DLMM builders on the pinned IDL. Customizable permissionless pairs, limit orders, swaps.
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { LiteSVM } from "litesvm";
import { dlmmProgram } from "./programs";
import { DLMM_PROGRAM_ID } from "./svm";

export const ILM_BASE = new PublicKey("MFGQxwAmB91SwuYX36okv2Qmdc9aMuHTwWGUrp4AtB1");
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DLMM_PROGRAM_ID)[0];
export const BINS_PER_ARRAY = 70;

function sorted(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  return a.toBuffer().compare(b.toBuffer()) < 0 ? [a, b] : [b, a];
}
export function deriveCustomizablePair(x: PublicKey, y: PublicKey): PublicKey {
  const [lo, hi] = sorted(x, y);
  return PublicKey.findProgramAddressSync([ILM_BASE.toBuffer(), lo.toBuffer(), hi.toBuffer()], DLMM_PROGRAM_ID)[0];
}
export function deriveReserve(pair: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([pair.toBuffer(), mint.toBuffer()], DLMM_PROGRAM_ID)[0];
}
export function deriveOracle(pair: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("oracle"), pair.toBuffer()], DLMM_PROGRAM_ID)[0];
}
export function binArrayIndex(binId: number): number {
  return Math.floor(binId / BINS_PER_ARRAY);
}
export function deriveBinArray(pair: PublicKey, index: number): PublicKey {
  const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(index));
  return PublicKey.findProgramAddressSync([Buffer.from("bin_array"), pair.toBuffer(), b], DLMM_PROGRAM_ID)[0];
}
export function binArraysFor(pair: PublicKey, binIds: number[]) {
  return Array.from(new Set(binIds.map(binArrayIndex))).map((i) => ({ pubkey: deriveBinArray(pair, i), isSigner: false, isWritable: true }));
}
export function getPair(svm: LiteSVM, pair: PublicKey): any {
  return dlmmProgram.coder.accounts.decode("lbPair", Buffer.from(svm.getAccount(pair)!.data));
}
export function getLimitOrder(svm: LiteSVM, order: PublicKey): any {
  return dlmmProgram.coder.accounts.decode("limitOrder", Buffer.from(svm.getAccount(order)!.data));
}

export enum ConcreteFunctionType { LimitOrder = 0, LiquidityMining = 1 }
export enum CollectFeeMode { InputOnly = 0, OnlyY = 1 }

/** Create a customizable permissionless pair. `funder` must hold some token X. */
export async function initPairIx(a: { x: PublicKey; y: PublicKey; funder: PublicKey; userTokenX: PublicKey; userTokenY: PublicKey; binStep: number; baseFactor: number; activeId?: number; functionType?: ConcreteFunctionType; collectFeeMode?: CollectFeeMode }) {
  const pair = deriveCustomizablePair(a.x, a.y);
  const ix = await dlmmProgram.methods.initializeCustomizablePermissionlessLbPair2({
    activeId: a.activeId ?? 0, binStep: a.binStep, baseFactor: a.baseFactor, activationType: 1, hasAlphaVault: false, activationPoint: null,
    creatorPoolOnOffControl: false, baseFeePowerFactor: 0, concreteFunctionType: a.functionType ?? ConcreteFunctionType.LimitOrder,
    collectFeeMode: a.collectFeeMode ?? CollectFeeMode.OnlyY, padding: new Array(60).fill(0),
  }).accountsStrict({
    lbPair: pair, binArrayBitmapExtension: DLMM_PROGRAM_ID, tokenMintX: a.x, tokenMintY: a.y, reserveX: deriveReserve(pair, a.x), reserveY: deriveReserve(pair, a.y),
    oracle: deriveOracle(pair), userTokenX: a.userTokenX, funder: a.funder, tokenBadgeX: DLMM_PROGRAM_ID, tokenBadgeY: DLMM_PROGRAM_ID,
    tokenProgramX: TOKEN_PROGRAM_ID, tokenProgramY: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, userTokenY: a.userTokenY,
    eventAuthority: EVENT_AUTHORITY, program: DLMM_PROGRAM_ID,
  }).instruction();
  return { ix, pair };
}

export async function initBinArrayIx(pair: PublicKey, index: number, funder: PublicKey) {
  return dlmmProgram.methods.initializeBinArray(new BN(index)).accountsStrict({ lbPair: pair, binArray: deriveBinArray(pair, index), funder, systemProgram: SystemProgram.programId }).instruction();
}

export async function placeLimitOrderIx(svm: LiteSVM, a: { pair: PublicKey; order: Keypair; owner: PublicKey; sender: PublicKey; payer: PublicKey; userToken: PublicKey; isAskSide: boolean; bins: { id: number; amount: BN }[] }) {
  const s = getPair(svm, a.pair);
  const ix = await dlmmProgram.methods.placeLimitOrder({ isAskSide: a.isAskSide, padding: new Array(16).fill(0), relativeBin: null, bins: a.bins }, { slices: [] }).accountsStrict({
    lbPair: a.pair, binArrayBitmapExtension: DLMM_PROGRAM_ID, reserve: a.isAskSide ? s.reserveX : s.reserveY, tokenMint: a.isAskSide ? s.tokenXMint : s.tokenYMint,
    limitOrder: a.order.publicKey, payer: a.payer, owner: a.owner, userToken: a.userToken, sender: a.sender, tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId, eventAuthority: EVENT_AUTHORITY, program: DLMM_PROGRAM_ID,
  }).remainingAccounts(binArraysFor(a.pair, a.bins.map((b) => b.id))).instruction();
  return ix as TransactionInstruction;
}

export async function cancelLimitOrderIx(svm: LiteSVM, a: { pair: PublicKey; order: PublicKey; owner: PublicKey; ownerTokenX: PublicKey; ownerTokenY: PublicKey; bins: number[] }) {
  const s = getPair(svm, a.pair);
  return dlmmProgram.methods.cancelLimitOrder(a.bins, { slices: [] }).accountsStrict({
    lbPair: a.pair, binArrayBitmapExtension: DLMM_PROGRAM_ID, reserveX: s.reserveX, reserveY: s.reserveY, tokenXMint: s.tokenXMint, tokenYMint: s.tokenYMint,
    limitOrder: a.order, ownerTokenX: a.ownerTokenX, ownerTokenY: a.ownerTokenY, owner: a.owner, tokenXProgram: TOKEN_PROGRAM_ID, tokenYProgram: TOKEN_PROGRAM_ID,
    memoProgram: MEMO_PROGRAM_ID, eventAuthority: EVENT_AUTHORITY, program: DLMM_PROGRAM_ID,
  }).remainingAccounts(binArraysFor(a.pair, a.bins)).instruction();
}
export async function closeLimitOrderIx(order: PublicKey, owner: PublicKey, rentReceiver: PublicKey) {
  return dlmmProgram.methods.closeLimitOrderIfEmpty().accountsStrict({ limitOrder: order, owner, rentReceiver, eventAuthority: EVENT_AUTHORITY, program: DLMM_PROGRAM_ID }).instruction();
}

/** Swap through bins; `binIds` are the bins the swap may touch (their arrays go in remaining accounts). */
export async function swap2Ix(svm: LiteSVM, a: { pair: PublicKey; user: PublicKey; tokenIn: PublicKey; tokenOut: PublicKey; amountIn: BN; minOut?: BN; binIds: number[] }) {
  const s = getPair(svm, a.pair);
  return dlmmProgram.methods.swap2(a.amountIn, a.minOut ?? new BN(0), { slices: [] }).accountsStrict({
    lbPair: a.pair, binArrayBitmapExtension: DLMM_PROGRAM_ID, reserveX: s.reserveX, reserveY: s.reserveY, userTokenIn: a.tokenIn, userTokenOut: a.tokenOut,
    tokenXMint: s.tokenXMint, tokenYMint: s.tokenYMint, oracle: deriveOracle(a.pair), hostFeeIn: DLMM_PROGRAM_ID, user: a.user,
    tokenXProgram: TOKEN_PROGRAM_ID, tokenYProgram: TOKEN_PROGRAM_ID, memoProgram: MEMO_PROGRAM_ID, eventAuthority: EVENT_AUTHORITY, program: DLMM_PROGRAM_ID,
  }).remainingAccounts(binArraysFor(a.pair, a.binIds)).instruction();
}

/** Independent per-bin fill reader for one of our orders, following DLMM's own reader
 *  (`commons/src/extensions/limit_order.rs`: status by order age, ceil unfilled share, fee shares).
 *  Used to check the program's settlement accounting against the bin arrays, not against itself. */
export function orderAmounts(svm: LiteSVM, pair: PublicKey, order: PublicKey, stIsX: boolean, ids?: number[]) {
  const data = Buffer.from(svm.getAccount(order)!.data);
  const header = getLimitOrder(svm, order);
  const collect = getPair(svm, pair).parameters.collectFeeMode;
  if (collect !== 1) throw new Error("orderAmounts expects an OnlyY pair");
  const n = (v: any) => BigInt(v.toString());
  const rows: { id: number; status: string; deposit: bigint; unfilled: bigint; filled: bigint; swapped: bigint; fee: bigint; wsolFees: bigint; stReceived: bigint }[] = [];
  for (let i = 0; i < header.binCount; i++) {
    const o = 120 + 32 * i;
    const amount = data.readBigUInt64LE(o), age = data.readUInt32LE(o + 8), id = data.readInt32LE(o + 16), ask = data[o + 20] !== 0;
    if (ids && !ids.includes(id)) continue;
    const arrayIndex = Math.floor(id / BINS_PER_ARRAY);
    const array: any = dlmmProgram.coder.accounts.decode("binArray", Buffer.from(svm.getAccount(deriveBinArray(pair, arrayIndex))!.data));
    const bin = array.bins[id - arrayIndex * BINS_PER_ARRAY];
    let status: string, unfilled = 0n;
    if (amount === 0n && age === 0) status = "empty";
    else if (age === bin.orderAge) { status = "unfilled"; unfilled = amount; }
    else if (age + 1 === bin.orderAge && (n(bin.openOrderAmount) > 0n || n(bin.processedOrderRemainingAmount) > 0n)) {
      status = "partial";
      const total = n(bin.totalProcessingOrderAmount);
      unfilled = total === 0n ? 0n : (amount * n(bin.processedOrderRemainingAmount) + total - 1n) / total;
    } else {
      if (!(age < bin.orderAge)) throw new Error("invalid order generation");
      status = "filled";
    }
    const filled = amount - unfilled, price = n(bin.price), Q = 1n << 64n;
    const swapped = filled === 0n ? 0n : ask ? (filled * price) / Q : (filled * Q) / price;
    const denominator = n(ask ? bin.fulfilledOrderAmountX : bin.fulfilledOrderAmountY);
    const fee = filled === 0n || denominator === 0n ? 0n : (n(ask ? bin.limitOrderFeeAskSide : bin.limitOrderFeeBidSide) * filled) / denominator;
    // OnlyY: WSOL fees when ST is X, ST fees (burned) when ST is Y
    rows.push({ id, status, deposit: amount, unfilled, filled, swapped, fee, wsolFees: stIsX ? fee : 0n, stReceived: swapped + (stIsX ? 0n : fee) });
  }
  return { rows, principal: rows.reduce((s, r) => s + r.unfilled, 0n), fees: rows.reduce((s, r) => s + r.wsolFees, 0n), st: rows.reduce((s, r) => s + r.stReceived, 0n) };
}
