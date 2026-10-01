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
