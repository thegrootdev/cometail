// Async counterparts of the LiteSVM harness builders, for a real cluster: every account the
// Meteora instructions need is derived, so a step needs at most one read.
import { BN, utils as anchorUtils } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { AccountLayout, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { deriveDammV2EventAuthority, deriveDammV2MigrationMetadataAddress, deriveDammV2PoolAddress, deriveDammV2PoolAuthority, deriveDammV2TokenVaultAddress, derivePositionAddress, derivePositionNftAccount, buildCurveWithMarketCap } from "@meteora-ag/dynamic-bonding-curve-sdk";
import fs from "fs";
import path from "path";
import { dbcProgram, dammProgram, dlmmProgram } from "../harness/programs";
import { normalize, poolAddrs, DBC_POOL_AUTHORITY } from "../harness/dbc";
import { DAMM_POOL_AUTHORITY, deriveDammTokenVault } from "../harness/damm";
import { DAMM_V2_PROGRAM_ID, DAMM_V2_MIGRATION_CONFIG } from "../harness/svm";
import * as dlmm from "../harness/dlmm";

const CONFIGS = path.resolve(__dirname, "..", "..", "configs");
export const log = (msg: string, extra?: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));

export async function send(connection: Connection, ixs: TransactionInstruction[], signers: Keypair[], opts: { cu?: number; label?: string } = {}): Promise<string> {
  const tx = new Transaction();
  if (opts.cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cu }));
  tx.add(...ixs);
  tx.feePayer = signers[0].publicKey;
  // the signature of every attempt is kept: a transaction that lands after its confirmation timed
  // out is reported as landed, never re-sent (a re-send would fail on the accounts it created)
  const sent: string[] = [];
  const landed = async (): Promise<string | null> => {
    if (!sent.length) return null;
    const statuses = (await connection.getSignatureStatuses(sent)).value;
    for (let i = 0; i < sent.length; i++) { const st = statuses[i]; if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sent[i]; }
    return null;
  };
  let last: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const latest = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = latest.blockhash;
      tx.lastValidBlockHeight = latest.lastValidBlockHeight;
      tx.signatures = [];
      tx.sign(...signers);
      const sig = anchorUtils.bytes.bs58.encode(tx.signature!);
      sent.push(sig);
      await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 2 });
      const res = await connection.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, "confirmed");
      if (res.value.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
      log(opts.label ?? "tx", { signature: sig, attempt });
      return sig;
    } catch (e: any) {
      last = e;
      const m = String(e?.message ?? e);
      const already = await landed();
      if (already) { log(opts.label ?? "tx", { signature: already, note: "landed after the confirmation timed out" }); return already; }
      if (/Blockhash not found|429|Too Many|timed out|block height exceeded|already in use|AlreadyProcessed/i.test(m) && attempt < 4) { await new Promise((r) => setTimeout(r, 2500 * attempt)); continue; }
      throw new Error(`${opts.label ?? "tx"} failed: ${m}\n${(e?.logs ?? []).join("\n")}`);
    }
  }
  throw last;
}

export const ata = (mint: PublicKey, owner: PublicKey, program = TOKEN_PROGRAM_ID) => getAssociatedTokenAddressSync(mint, owner, true, program);
export const ataIx = (payer: PublicKey, mint: PublicKey, owner: PublicKey, program = TOKEN_PROGRAM_ID) => createAssociatedTokenAccountIdempotentInstruction(payer, ata(mint, owner, program), owner, mint, program);
export function wrapSolIxs(owner: PublicKey, lamports: BN): TransactionInstruction[] {
  const dest = ata(NATIVE_MINT, owner);
  return [ataIx(owner, NATIVE_MINT, owner), SystemProgram.transfer({ fromPubkey: owner, toPubkey: dest, lamports: BigInt(lamports.toString()) }), createSyncNativeInstruction(dest)];
}
/** Public endpoints throttle reads too: retry a read a few times with backoff. */
export async function retry<T>(what: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i)); }
  }
  throw new Error(`${what}: ${String((last as Error)?.message ?? last)}`);
}
const getInfo = (connection: Connection, pk: PublicKey) => retry(`read ${pk.toBase58()}`, () => connection.getAccountInfo(pk, "confirmed"));
export async function tokenBalance(connection: Connection, account: PublicKey): Promise<BN> {
  const info = await getInfo(connection, account);
  return info ? new BN(AccountLayout.decode(info.data).amount.toString()) : new BN(0);
}
export async function tokenOwner(connection: Connection, account: PublicKey): Promise<PublicKey | null> {
  const info = await getInfo(connection, account);
  return info ? new PublicKey(AccountLayout.decode(info.data).owner) : null;
}
async function decode(connection: Connection, program: any, name: string, pk: PublicKey): Promise<any> {
  const info = await getInfo(connection, pk);
  if (!info) throw new Error(`missing account ${pk.toBase58()} (${name})`);
  return program.coder.accounts.decode(name, info.data);
}
export const dbcPool = async (c: Connection, pk: PublicKey) => (await decode(c, dbcProgram, "virtualPool", pk)).poolState;
export const dbcConfig = (c: Connection, pk: PublicKey) => decode(c, dbcProgram, "poolConfig", pk);
export const dammPool = (c: Connection, pk: PublicKey) => decode(c, dammProgram, "pool", pk);
export const dammPosition = (c: Connection, pk: PublicKey) => decode(c, dammProgram, "position", pk);
export const dlmmPair = (c: Connection, pk: PublicKey) => decode(c, dlmmProgram, "lbPair", pk);

/** The repo's config parameters with the market caps scaled down, so a devnet curve fills with a fraction of a SOL. */
export function smallConfigParams(name: "plain" | "stream-25" | "stream-50" | "stream-75", scale = 80): any {
  const p = JSON.parse(fs.readFileSync(path.join(CONFIGS, `${name}.json`), "utf8"));
  p.initialMarketCap = p.initialMarketCap / scale;
  p.migrationMarketCap = p.migrationMarketCap / scale;
  return normalize(buildCurveWithMarketCap(p));
}
export async function createConfigIx(a: { config: PublicKey; feeClaimer: PublicKey; leftoverReceiver: PublicKey; payer: PublicKey; params: any }) {
  return dbcProgram.methods.createConfig(a.params).accountsPartial({ config: a.config, feeClaimer: a.feeClaimer, leftoverReceiver: a.leftoverReceiver, quoteMint: NATIVE_MINT, payer: a.payer, systemProgram: SystemProgram.programId }).instruction();
}
export async function transferPoolCreatorIx(pool: PublicKey, config: PublicKey, creator: PublicKey, newCreator: PublicKey) {
  return dbcProgram.methods.transferPoolCreator().accountsPartial({ virtualPool: pool, config, creator, newCreator }).instruction();
}
/** Buy from a curve with WSOL (partial fill so a large amount completes the curve). */
export async function curveBuyIx(a: { config: PublicKey; baseMint: PublicKey; buyer: PublicKey; amountIn: BN; baseProgram?: PublicKey }) {
  const addrs = poolAddrs(a.config, a.baseMint, NATIVE_MINT);
  const baseProgram = a.baseProgram ?? TOKEN_PROGRAM_ID;
  return dbcProgram.methods.swap2({ amount0: a.amountIn, amount1: new BN(0), swapMode: 1 }).accountsPartial({
    poolAuthority: DBC_POOL_AUTHORITY, config: a.config, pool: addrs.pool, inputTokenAccount: ata(NATIVE_MINT, a.buyer), outputTokenAccount: ata(a.baseMint, a.buyer, baseProgram),
    baseVault: addrs.baseVault, quoteVault: addrs.quoteVault, baseMint: a.baseMint, quoteMint: NATIVE_MINT, payer: a.buyer, tokenBaseProgram: baseProgram, tokenQuoteProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
  }).remainingAccounts([{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }]).instruction();
}
/** Migrate a completed curve into DAMM v2 through Meteora's customizable config. Returns the pool and both position addresses. */
export async function migrateToDammV2(connection: Connection, payer: Keypair, a: { config: PublicKey; baseMint: PublicKey }) {
  const addrs = poolAddrs(a.config, a.baseMint, NATIVE_MINT);
  const metadata = deriveDammV2MigrationMetadataAddress(addrs.pool);
  if (!(await getInfo(connection, metadata))) {
    const m = await dbcProgram.methods.migrationDammV2CreateMetadata().accountsPartial({ virtualPool: addrs.pool, config: a.config, migrationMetadata: metadata, payer: payer.publicKey, systemProgram: SystemProgram.programId }).instruction();
    await send(connection, [m], [payer], { label: "dbc.migration_damm_v2_create_metadata" });
  }
  const dammConfig = DAMM_V2_MIGRATION_CONFIG.customizable;
  const pool = deriveDammV2PoolAddress(dammConfig, a.baseMint, NATIVE_MINT);
  const first = Keypair.generate(), second = Keypair.generate();
  const ix = await dbcProgram.methods.migrationDammV2().accountsPartial({
    virtualPool: addrs.pool, migrationMetadata: metadata, config: a.config, poolAuthority: DBC_POOL_AUTHORITY, pool,
    firstPositionNftMint: first.publicKey, firstPositionNftAccount: derivePositionNftAccount(first.publicKey), firstPosition: derivePositionAddress(first.publicKey),
    secondPositionNftMint: second.publicKey, secondPositionNftAccount: derivePositionNftAccount(second.publicKey), secondPosition: derivePositionAddress(second.publicKey),
    dammPoolAuthority: deriveDammV2PoolAuthority(), ammProgram: DAMM_V2_PROGRAM_ID, baseMint: a.baseMint, quoteMint: NATIVE_MINT,
    tokenAVault: deriveDammV2TokenVaultAddress(pool, a.baseMint), tokenBVault: deriveDammV2TokenVaultAddress(pool, NATIVE_MINT),
    baseVault: addrs.baseVault, quoteVault: addrs.quoteVault, payer: payer.publicKey, tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID, dammEventAuthority: deriveDammV2EventAuthority(), systemProgram: SystemProgram.programId,
  }).remainingAccounts([{ pubkey: dammConfig, isSigner: false, isWritable: false }]).instruction();
  await send(connection, [ix], [payer, first, second], { cu: 600_000, label: "dbc.migration_damm_v2" });
  return { pool, positions: [derivePositionAddress(first.publicKey), derivePositionAddress(second.publicKey)] };
}
export async function positionOwnedBy(connection: Connection, positions: PublicKey[], owner: PublicKey) {
  for (const p of positions) {
    const state = await dammPosition(connection, p);
    const nftAccount = derivePositionNftAccount(state.nftMint);
    const holder = await tokenOwner(connection, nftAccount);
    if (holder && holder.equals(owner)) return { position: p, nftAccount, nftMint: state.nftMint as PublicKey, state };
  }
  return null;
}
/** Swap on a DAMM v2 pool (both mints SPL, quote WSOL). */
export async function dammSwapIx(connection: Connection, a: { pool: PublicKey; payer: PublicKey; inputMint: PublicKey; outputMint: PublicKey; amountIn: BN }) {
  const p = await dammPool(connection, a.pool);
  return dammProgram.methods.swap({ amountIn: a.amountIn, minimumAmountOut: new BN(0) }).accountsPartial({
    poolAuthority: DAMM_POOL_AUTHORITY, pool: a.pool, payer: a.payer, inputTokenAccount: ata(a.inputMint, a.payer), outputTokenAccount: ata(a.outputMint, a.payer),
    tokenAVault: p.tokenAVault, tokenBVault: p.tokenBVault, tokenAMint: p.tokenAMint, tokenBMint: p.tokenBMint, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
  }).remainingAccounts([{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }]).instruction();
}
/** Sell token X into a DLMM pair (or Y when `sellY`), touching the given bins. */
export async function dlmmSwapIx(connection: Connection, a: { pair: PublicKey; user: PublicKey; amountIn: BN; sellY?: boolean; binIds: number[] }) {
  const s = await dlmmPair(connection, a.pair);
  const [tokenIn, tokenOut] = a.sellY ? [ata(s.tokenYMint, a.user), ata(s.tokenXMint, a.user)] : [ata(s.tokenXMint, a.user), ata(s.tokenYMint, a.user)];
  return dlmmProgram.methods.swap2(a.amountIn, new BN(0), { slices: [] }).accountsStrict({
    lbPair: a.pair, binArrayBitmapExtension: dlmm.deriveBinArray(a.pair, 0).equals(a.pair) ? a.pair : dlmmProgram.programId, reserveX: s.reserveX, reserveY: s.reserveY, userTokenIn: tokenIn, userTokenOut: tokenOut,
    tokenXMint: s.tokenXMint, tokenYMint: s.tokenYMint, oracle: dlmm.deriveOracle(a.pair), hostFeeIn: dlmmProgram.programId, user: a.user,
    tokenXProgram: TOKEN_PROGRAM_ID, tokenYProgram: TOKEN_PROGRAM_ID, memoProgram: dlmm.MEMO_PROGRAM_ID, eventAuthority: dlmm.EVENT_AUTHORITY, program: dlmmProgram.programId,
  }).remainingAccounts(dlmm.binArraysFor(a.pair, a.binIds)).instruction();
}
export { deriveDammV2PoolAddress, derivePositionNftAccount, poolAddrs, DAMM_V2_MIGRATION_CONFIG, deriveDammTokenVault, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID };
