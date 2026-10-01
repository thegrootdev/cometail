// DBC instruction builders and decoders on the pinned IDL, plus the config files.
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  buildCurveWithMarketCap, deriveDammV2EventAuthority, deriveDammV2MigrationMetadataAddress, deriveDammV2PoolAddress,
  deriveDammV2PoolAuthority, deriveDammV2TokenVaultAddress, deriveDbcPoolAddress, deriveDbcPoolAuthority,
  deriveDbcTokenVaultAddress, deriveMintMetadata, derivePositionAddress, derivePositionNftAccount,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { LiteSVM } from "litesvm";
import fs from "fs";
import path from "path";
import { dbcProgram } from "./programs";
import { send } from "./tx";
import { DAMM_V2_PROGRAM_ID, METAPLEX_PROGRAM_ID } from "./svm";

export const DBC_POOL_AUTHORITY = deriveDbcPoolAuthority();
export enum SwapMode { ExactIn = 0, PartialFill = 1, ExactOut = 2 }
export enum MigrationProgress { PreBondingCurve = 0, PostBondingCurve = 1, LockedVesting = 2, CreatedPool = 3 }

const CONFIGS = path.resolve(__dirname, "..", "..", "configs");

/** The SDK's bn.js copy may differ from ours; re-wrap every BN so the Anchor coder accepts it. */
export function normalize(v: any): any {
  if (v === null || v === undefined) return v;
  if (BN.isBN(v)) return new BN(v.toString());
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === "object" && !(v instanceof PublicKey)) { const o: any = {}; for (const k of Object.keys(v)) o[k] = normalize(v[k]); return o; }
  return v;
}

export function configParams(name: "stream-25" | "stream-50" | "stream-75" | "plain"): any {
  const p = JSON.parse(fs.readFileSync(path.join(CONFIGS, `${name}.json`), "utf8"));
  return normalize(buildCurveWithMarketCap(p));
}

export async function createConfig(svm: LiteSVM, a: { payer: Keypair; feeClaimer: PublicKey; leftoverReceiver: PublicKey; quoteMint: PublicKey; params: any }): Promise<PublicKey> {
  const config = Keypair.generate();
  const ix = await dbcProgram.methods.createConfig(a.params).accountsPartial({
    config: config.publicKey, feeClaimer: a.feeClaimer, leftoverReceiver: a.leftoverReceiver, quoteMint: a.quoteMint, payer: a.payer.publicKey, systemProgram: SystemProgram.programId,
  }).instruction();
  send(svm, [ix], [a.payer, config], { label: "dbc.create_config" });
  return config.publicKey;
}

export type PoolAddrs = { pool: PublicKey; baseVault: PublicKey; quoteVault: PublicKey; metadata: PublicKey };
export function poolAddrs(config: PublicKey, baseMint: PublicKey, quoteMint: PublicKey): PoolAddrs {
  const pool = deriveDbcPoolAddress(quoteMint, baseMint, config);
  return { pool, baseVault: deriveDbcTokenVaultAddress(pool, baseMint), quoteVault: deriveDbcTokenVaultAddress(pool, quoteMint), metadata: deriveMintMetadata(baseMint) };
}

export async function createPoolIx(a: { config: PublicKey; baseMint: PublicKey; quoteMint: PublicKey; creator: PublicKey; payer: PublicKey; name?: string; symbol?: string; uri?: string }) {
  const addrs = poolAddrs(a.config, a.baseMint, a.quoteMint);
  const ix = await dbcProgram.methods
    .initializeVirtualPoolWithSplToken({ name: a.name ?? "token", symbol: a.symbol ?? "TKN", uri: a.uri ?? "https://cometail.fun/meta.json" })
    .accountsPartial({
      config: a.config, poolAuthority: DBC_POOL_AUTHORITY, creator: a.creator, baseMint: a.baseMint, quoteMint: a.quoteMint, pool: addrs.pool,
      baseVault: addrs.baseVault, quoteVault: addrs.quoteVault, mintMetadata: addrs.metadata, metadataProgram: METAPLEX_PROGRAM_ID, payer: a.payer,
      tokenQuoteProgram: TOKEN_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .instruction();
  return { ix, ...addrs };
}

export async function swap2Ix(svm: LiteSVM, a: { pool: PublicKey; payer: PublicKey; inputMint: PublicKey; outputMint: PublicKey; inputAccount: PublicKey; outputAccount: PublicKey; amount0: BN; amount1: BN; mode: SwapMode }) {
  const p = getPool(svm, a.pool);
  const cfg = getConfig(svm, p.config);
  return dbcProgram.methods
    .swap2({ amount0: a.amount0, amount1: a.amount1, swapMode: a.mode })
    .accountsPartial({
      poolAuthority: DBC_POOL_AUTHORITY, config: p.config, pool: a.pool, inputTokenAccount: a.inputAccount, outputTokenAccount: a.outputAccount,
      baseVault: p.baseVault, quoteVault: p.quoteVault, baseMint: p.baseMint, quoteMint: cfg.quoteMint, payer: a.payer,
      tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
    })
    .remainingAccounts([{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }])
    .instruction();
}

/** Buy from the curve with quote; partial fill so a large amount completes the curve. */
export async function buy(svm: LiteSVM, buyer: Keypair, pool: PublicKey, quoteAccount: PublicKey, baseAccount: PublicKey, amountIn: BN, mode = SwapMode.PartialFill) {
  const p = getPool(svm, pool);
  const cfg = getConfig(svm, p.config);
  const ix = await swap2Ix(svm, { pool, payer: buyer.publicKey, inputMint: cfg.quoteMint, outputMint: p.baseMint, inputAccount: quoteAccount, outputAccount: baseAccount, amount0: amountIn, amount1: new BN(0), mode });
  return send(svm, [ix], [buyer], { label: "dbc.swap2" });
}

export async function migrateToDammV2(svm: LiteSVM, payer: Keypair, pool: PublicKey, dammConfig: PublicKey) {
  const p = getPool(svm, pool);
  const cfg = getConfig(svm, p.config);
  const metadata = deriveDammV2MigrationMetadataAddress(pool);
  if (!svm.getAccount(metadata)) {
    const mIx = await dbcProgram.methods.migrationDammV2CreateMetadata().accountsPartial({ virtualPool: pool, config: p.config, migrationMetadata: metadata, payer: payer.publicKey, systemProgram: SystemProgram.programId }).instruction();
    send(svm, [mIx], [payer], { label: "dbc.migration_damm_v2_create_metadata" });
  }
  const dammPool = deriveDammV2PoolAddress(dammConfig, p.baseMint, cfg.quoteMint);
  const first = Keypair.generate(); const second = Keypair.generate();
  const ix = await dbcProgram.methods.migrationDammV2().accountsPartial({
    virtualPool: pool, migrationMetadata: metadata, config: p.config, poolAuthority: DBC_POOL_AUTHORITY, pool: dammPool,
    firstPositionNftMint: first.publicKey, firstPositionNftAccount: derivePositionNftAccount(first.publicKey), firstPosition: derivePositionAddress(first.publicKey),
    secondPositionNftMint: second.publicKey, secondPositionNftAccount: derivePositionNftAccount(second.publicKey), secondPosition: derivePositionAddress(second.publicKey),
    dammPoolAuthority: deriveDammV2PoolAuthority(), ammProgram: DAMM_V2_PROGRAM_ID, baseMint: p.baseMint, quoteMint: cfg.quoteMint,
    tokenAVault: deriveDammV2TokenVaultAddress(dammPool, p.baseMint), tokenBVault: deriveDammV2TokenVaultAddress(dammPool, cfg.quoteMint),
    baseVault: p.baseVault, quoteVault: p.quoteVault, payer: payer.publicKey, tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID, dammEventAuthority: deriveDammV2EventAuthority(), systemProgram: SystemProgram.programId,
  }).remainingAccounts([{ pubkey: dammConfig, isSigner: false, isWritable: false }]).instruction();
  send(svm, [ix], [payer, first, second], { cu: 600_000, label: "dbc.migration_damm_v2" });
  return { dammPool, firstPosition: derivePositionAddress(first.publicKey), secondPosition: derivePositionAddress(second.publicKey) };
}

export async function claimCreatorTradingFeeIx(svm: LiteSVM, pool: PublicKey, creator: PublicKey, baseDest: PublicKey, quoteDest: PublicKey, maxBase: BN, maxQuote: BN) {
  const p = getPool(svm, pool); const cfg = getConfig(svm, p.config);
  return dbcProgram.methods.claimCreatorTradingFee(maxBase, maxQuote).accountsPartial({
    poolAuthority: DBC_POOL_AUTHORITY, pool, tokenAAccount: baseDest, tokenBAccount: quoteDest, baseVault: p.baseVault, quoteVault: p.quoteVault,
    baseMint: p.baseMint, quoteMint: cfg.quoteMint, creator, tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
  }).instruction();
}
export async function claimPartnerTradingFeeIx(svm: LiteSVM, pool: PublicKey, feeClaimer: PublicKey, baseDest: PublicKey, quoteDest: PublicKey) {
  const p = getPool(svm, pool); const cfg = getConfig(svm, p.config);
  return dbcProgram.methods.claimTradingFee(new BN("18446744073709551615"), new BN("18446744073709551615")).accountsPartial({
    poolAuthority: DBC_POOL_AUTHORITY, config: p.config, pool, tokenAAccount: baseDest, tokenBAccount: quoteDest, baseVault: p.baseVault, quoteVault: p.quoteVault,
    baseMint: p.baseMint, quoteMint: cfg.quoteMint, feeClaimer, tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
  }).instruction();
}
export async function withdrawMigrationFeeIx(svm: LiteSVM, pool: PublicKey, sender: PublicKey, quoteDest: PublicKey, flag: 0 | 1) {
  const p = getPool(svm, pool); const cfg = getConfig(svm, p.config);
  return dbcProgram.methods.withdrawMigrationFee(flag).accountsPartial({
    poolAuthority: DBC_POOL_AUTHORITY, config: p.config, virtualPool: pool, tokenQuoteAccount: quoteDest, quoteVault: p.quoteVault, quoteMint: cfg.quoteMint, sender, tokenQuoteProgram: TOKEN_PROGRAM_ID,
  }).instruction();
}
export async function creatorWithdrawSurplusIx(svm: LiteSVM, pool: PublicKey, creator: PublicKey, quoteDest: PublicKey) {
  const p = getPool(svm, pool); const cfg = getConfig(svm, p.config);
  return dbcProgram.methods.creatorWithdrawSurplus().accountsPartial({
    poolAuthority: DBC_POOL_AUTHORITY, config: p.config, virtualPool: pool, tokenQuoteAccount: quoteDest, quoteVault: p.quoteVault, quoteMint: cfg.quoteMint, creator, tokenQuoteProgram: TOKEN_PROGRAM_ID,
  }).instruction();
}
export async function transferPoolCreatorIx(svm: LiteSVM, pool: PublicKey, creator: PublicKey, newCreator: PublicKey) {
  const p = getPool(svm, pool);
  return dbcProgram.methods.transferPoolCreator().accountsPartial({ virtualPool: pool, config: p.config, creator, newCreator }).instruction();
}
export async function claimPartnerPoolCreationFeeIx(svm: LiteSVM, pool: PublicKey, feeClaimer: PublicKey, feeReceiver: PublicKey) {
  const p = getPool(svm, pool);
  return dbcProgram.methods.claimPartnerPoolCreationFee().accountsPartial({ config: p.config, pool, feeClaimer, feeReceiver }).instruction();
}

/** The VirtualPool account wraps its fields in `poolState` (DBC 0.2.0 IDL change); this returns the inner state. */
export function getPool(svm: LiteSVM, pool: PublicKey): any {
  return dbcProgram.coder.accounts.decode("virtualPool", Buffer.from(svm.getAccount(pool)!.data)).poolState;
}
export function getConfig(svm: LiteSVM, config: PublicKey): any {
  return dbcProgram.coder.accounts.decode("poolConfig", Buffer.from(svm.getAccount(config)!.data));
}
