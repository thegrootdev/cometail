// What a vault needs before its first bid, done by the keeper without anyone's help:
// the stream token's DLMM pair at the graduated pool's price, the bin arrays the ladder
// will use, and the write-once registration; plus the permissionless migration of every
// complete curve the protocol cares about (vault streams and plain launches on its configs).
import { BN } from "@coral-xyz/anchor";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { DLMM_PROGRAM_ID } from "@cometail/client";
import { Chain, DBC_PROGRAM_ID, DBC_PROGRESS, isDefault } from "./chain";
import { Config } from "./config";
import { binsForSpread } from "./ladder";
import { log, sendTx } from "./tx";
import type { Keypair } from "@solana/web3.js";

export interface BootstrapContext { chain: Chain; cfg: Config; keeper: Keypair }

const ILM_BASE = new PublicKey("MFGQxwAmB91SwuYX36okv2Qmdc9aMuHTwWGUrp4AtB1");
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const DLMM_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DLMM_PROGRAM_ID)[0];
const DAMM_POOL_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"))[0];
const BINS_PER_ARRAY = 70;
/** The bin step and base fee every pair gets: 1% bins, 0.1% base fee (base_factor 1000 x step 100 x 10 = 1e6 of 1e9). */
export const PAIR_BIN_STEP = 100;
export const PAIR_BASE_FACTOR = 1000;
/** Stream token the keeper buys to fund the pair (DLMM requires the funder to hold token X). */
const PAIR_FUNDING_LAMPORTS = 1_000_000;

const sorted = (a: PublicKey, b: PublicKey): [PublicKey, PublicKey] => (a.toBuffer().compare(b.toBuffer()) < 0 ? [a, b] : [b, a]);
export function deriveCustomizablePair(x: PublicKey, y: PublicKey): PublicKey {
  const [lo, hi] = sorted(x, y);
  return PublicKey.findProgramAddressSync([ILM_BASE.toBuffer(), lo.toBuffer(), hi.toBuffer()], DLMM_PROGRAM_ID)[0];
}
const reserve = (pair: PublicKey, mint: PublicKey) => PublicKey.findProgramAddressSync([pair.toBuffer(), mint.toBuffer()], DLMM_PROGRAM_ID)[0];
const oracle = (pair: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("oracle"), pair.toBuffer()], DLMM_PROGRAM_ID)[0];
export function binArray(pair: PublicKey, index: number): PublicKey {
  const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(index));
  return PublicKey.findProgramAddressSync([Buffer.from("bin_array"), pair.toBuffer(), b], DLMM_PROGRAM_ID)[0];
}

/** The pool's price as a DLMM bin id: price = (sqrt_price / 2^64)^2 lamports per raw unit, bin = log(price) / log(1 + step / 10000). */
export function binIdForPrice(sqrtPrice: bigint, binStep: number, stIsTokenA: boolean): number {
  const p = (Number(sqrtPrice) / 2 ** 64) ** 2; // B per A
  const price = stIsTokenA ? p : 1 / p; // Y per X with ST as X
  return Math.round(Math.log(price) / Math.log(1 + binStep / 10_000));
}

/** Create, prepare and register the pair of a Live vault that has none yet. */
export async function bootstrapPair(ctx: BootstrapContext, vaultPk: PublicKey, vault: any): Promise<boolean> {
  const { chain, cfg, keeper } = ctx;
  const stMint: PublicKey = vault.stMint;
  const pool = await chain.dammPool(vault.dammPool);
  if (!pool) return false;
  const pair = deriveCustomizablePair(stMint, NATIVE_MINT);
  const existing = await chain.lbPair(pair);
  const keeperSt = getAssociatedTokenAddressSync(stMint, keeper.publicKey);
  const keeperWsol = getAssociatedTokenAddressSync(NATIVE_MINT, keeper.publicKey);
  if (!existing) {
    // 1. a little stream token for the funder, bought on the graduated pool
    if ((await chain.tokenBalance(keeperSt)) === 0n) {
      const buy = await chain.damm.methods.swap({ amountIn: new BN(PAIR_FUNDING_LAMPORTS), minimumAmountOut: new BN(0) }).accountsPartial({
        poolAuthority: DAMM_POOL_AUTHORITY, pool: vault.dammPool, payer: keeper.publicKey, inputTokenAccount: keeperWsol, outputTokenAccount: keeperSt,
        tokenAVault: pool.tokenAVault, tokenBVault: pool.tokenBVault, tokenAMint: pool.tokenAMint, tokenBMint: pool.tokenBMint, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
      } as never).remainingAccounts([{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }]).instruction();
      const r = await sendTx({ connection: chain.connection, payer: keeper, ixs: [
        createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, keeperWsol, keeper.publicKey, NATIVE_MINT),
        SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: keeperWsol, lamports: PAIR_FUNDING_LAMPORTS }), createSyncNativeInstruction(keeperWsol),
        createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, keeperSt, keeper.publicKey, stMint), buy,
      ], cu: 400_000, cuPrice: cfg.cuPriceMicroLamports, dryRun: cfg.dryRun, label: `pair funding ${vaultPk.toBase58()}` });
      if (!r.ok) return false;
    }
    // 2. the pair, at the pool's price
    const activeId = binIdForPrice(BigInt(pool.sqrtPrice.toString()), PAIR_BIN_STEP, pool.tokenAMint.equals(stMint));
    const init = await chain.dlmm.methods.initializeCustomizablePermissionlessLbPair2({
      activeId, binStep: PAIR_BIN_STEP, baseFactor: PAIR_BASE_FACTOR, activationType: 1, hasAlphaVault: false, activationPoint: null,
      creatorPoolOnOffControl: false, baseFeePowerFactor: 0, concreteFunctionType: 0, collectFeeMode: 1, padding: new Array(60).fill(0),
    }).accountsStrict({
      lbPair: pair, binArrayBitmapExtension: DLMM_PROGRAM_ID, tokenMintX: stMint, tokenMintY: NATIVE_MINT, reserveX: reserve(pair, stMint), reserveY: reserve(pair, NATIVE_MINT),
      oracle: oracle(pair), userTokenX: keeperSt, funder: keeper.publicKey, tokenBadgeX: DLMM_PROGRAM_ID, tokenBadgeY: DLMM_PROGRAM_ID,
      tokenProgramX: TOKEN_PROGRAM_ID, tokenProgramY: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, userTokenY: keeperWsol,
      eventAuthority: DLMM_EVENT_AUTHORITY, program: DLMM_PROGRAM_ID,
    }).instruction();
    const r = await sendTx({ connection: chain.connection, payer: keeper, ixs: [init], cu: 400_000, cuPrice: cfg.cuPriceMicroLamports, dryRun: cfg.dryRun, label: `pair ${pair.toBase58()} active=${activeId}` });
    if (!r.ok) return false;
  }
  const state = await chain.lbPair(pair);
  if (!state) return false;
  // 3. bin arrays for the ladder's band on the buying side (and the active bin's array)
  const stIsX = state.tokenXMint.equals(stMint);
  const far = binsForSpread(cfg.ladderFarBps, Number(state.binStep)) + 5;
  const edge = stIsX ? state.activeId - far : state.activeId + far;
  if (!(await ensureBinArrays(ctx, pair, [state.activeId, edge]))) return false;
  // 4. write-once registration
  if (isDefault(vault.dlmmPair)) {
    const ix = await chain.client.registerPair({ vault: vaultPk, signer: keeper.publicKey, lbPair: pair });
    const r = await sendTx({ connection: chain.connection, payer: keeper, ixs: [ix], cu: 200_000, cuPrice: cfg.cuPriceMicroLamports, parser: chain.events, dryRun: cfg.dryRun, label: `register_pair ${vaultPk.toBase58()}` });
    return r.ok;
  }
  return true;
}

/** The bin arrays that hold these bins (and everything between), created when missing. */
export async function ensureBinArrays(ctx: BootstrapContext, pair: PublicKey, binIds: number[]): Promise<boolean> {
  const { chain, cfg, keeper } = ctx;
  const indexes = binIds.map((b) => Math.floor(b / BINS_PER_ARRAY));
  const lo = Math.min(...indexes), hi = Math.max(...indexes);
  for (let i = lo; i <= hi; i++) {
    const key = binArray(pair, i);
    if (await chain.connection.getAccountInfo(key)) continue;
    const ix = await chain.dlmm.methods.initializeBinArray(new BN(i)).accountsStrict({ lbPair: pair, binArray: key, funder: keeper.publicKey, systemProgram: SystemProgram.programId }).instruction();
    const r = await sendTx({ connection: chain.connection, payer: keeper, ixs: [ix], cu: 1_400_000, cuPrice: cfg.cuPriceMicroLamports, dryRun: cfg.dryRun, label: `bin array ${i} of ${pair.toBase58()}` });
    if (!r.ok) return false;
  }
  return true;
}

/** Complete curves on the protocol's own configs (plain launches): migrate them. */
export async function migratePlainLaunches(ctx: BootstrapContext, migrate: (poolPk: PublicKey, pool: any) => Promise<void>): Promise<void> {
  const { chain, cfg } = ctx;
  const disc = chain.dbc.coder.accounts.memcmp("virtualPool") as { offset: number; bytes: string };
  for (const config of cfg.migrateConfigs) {
    const found = await chain.connection.getProgramAccounts(DBC_PROGRAM_ID, { commitment: "confirmed", filters: [{ memcmp: disc }, { memcmp: { offset: 72, bytes: config.toBase58() } }] });
    for (const a of found) {
      const state = chain.dbc.coder.accounts.decode("virtualPool", a.account.data).poolState;
      const progress = Number(state.migrationProgress);
      if (progress === DBC_PROGRESS.lockedVesting || progress === DBC_PROGRESS.postBonding) {
        log("plain launch complete; migrating", { pool: a.pubkey, config });
        await migrate(a.pubkey, state);
      }
    }
  }
}
export { MEMO_PROGRAM_ID };
