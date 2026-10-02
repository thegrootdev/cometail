// Instruction builders for the COMETAIL vault program. Pure: no RPC, no signing.
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, AuthorityType, createSetAuthorityInstruction, getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID, DLMM_PROGRAM_ID, deriveProtocol, deriveVault, SEEDS } from "./ids";

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const VAULT_IDL = require("../idl/cometail_vault.json") as Idl;
export const VAULT_PROGRAM_ID = new PublicKey((VAULT_IDL as any).address);

export function vaultProgram(connection?: Connection): Program {
  const provider = new AnchorProvider(connection ?? new Connection("http://127.0.0.1:8899"), new Wallet(Keypair.generate()), {});
  return new Program(VAULT_IDL, provider);
}

export const CP_AMM_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DAMM_V2_PROGRAM_ID)[0];
export const DBC_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DBC_PROGRAM_ID)[0];
export const CP_AMM_POOL_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], DAMM_V2_PROGRAM_ID)[0];

export function deriveStream(vault: PublicKey, index: number): PublicKey {
  const b = Buffer.alloc(4); b.writeUInt32LE(index);
  return PublicKey.findProgramAddressSync([SEEDS.stream, vault.toBuffer(), b], VAULT_PROGRAM_ID)[0];
}
export function deriveStreamIndex(source: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEEDS.streamIndex, source.toBuffer()], VAULT_PROGRAM_ID)[0];
}
export function deriveOrderRecord(vault: PublicKey, limitOrder: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEEDS.order, vault.toBuffer(), limitOrder.toBuffer()], VAULT_PROGRAM_ID)[0];
}
export function dammPositionNftAccount(nftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("position_nft_account"), nftMint.toBuffer()], DAMM_V2_PROGRAM_ID)[0];
}
export function dammPosition(nftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("position"), nftMint.toBuffer()], DAMM_V2_PROGRAM_ID)[0];
}

/** Hand a position NFT that sits in cp-amm's own PDA account to the vault: the account's authority
 *  moves, the NFT stays where the migration put it. This is how a migrated creator position enters a
 *  vault (`deposit_dbc_rights_migrated`); `withdraw_stream` hands the authority back. */
export function handPositionNftToVaultIx(nftMint: PublicKey, currentOwner: PublicKey, vault: PublicKey): TransactionInstruction {
  return createSetAuthorityInstruction(dammPositionNftAccount(nftMint), currentOwner, AuthorityType.AccountOwner, vault, [], TOKEN_2022_PROGRAM_ID);
}

export type RoutingPolicy = { maxSpendPerPeriod: BN; periodSeconds: BN; maxOutstandingOrders: number; maxBinsPerOrder: number; maxPriceQ64: BN };

export class VaultClient {
  readonly program: Program;
  constructor(connection?: Connection) { this.program = vaultProgram(connection); }

  get protocol(): PublicKey { return deriveProtocol(VAULT_PROGRAM_ID)[0]; }
  vault(stMint: PublicKey): PublicKey { return deriveVault(VAULT_PROGRAM_ID, stMint)[0]; }

  /** The program's upgradeable-loader ProgramData account (where the upgrade authority lives). */
  get programData(): PublicKey { return PublicKey.findProgramAddressSync([VAULT_PROGRAM_ID.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0]; }
  /** `admin` must be the program's upgrade authority; `treasury` is its WSOL ATA (derived here unless given). */
  async initProtocol(a: { admin: PublicKey; keeper: PublicKey; payer: PublicKey; streamConfigs: [PublicKey, PublicKey, PublicKey]; treasury?: PublicKey; programData?: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.initProtocol().accountsPartial({
      protocol: this.protocol, admin: a.admin, program: VAULT_PROGRAM_ID, programData: a.programData ?? this.programData, keeper: a.keeper,
      treasury: a.treasury ?? getAssociatedTokenAddressSync(NATIVE_MINT, a.admin), config25: a.streamConfigs[0], config50: a.streamConfigs[1], config75: a.streamConfigs[2],
      payer: a.payer, systemProgram: SystemProgram.programId,
    }).instruction();
  }
  async updateProtocol(a: { admin: PublicKey; keeper?: PublicKey; treasury?: PublicKey; streamConfigs?: [PublicKey | null, PublicKey | null, PublicKey | null]; pausedRouting?: boolean }): Promise<TransactionInstruction> {
    return this.program.methods.updateProtocol(a.pausedRouting ?? null).accountsPartial({
      protocol: this.protocol, admin: a.admin, keeper: a.keeper ?? null, treasury: a.treasury ?? null,
      config25: a.streamConfigs?.[0] ?? null, config50: a.streamConfigs?.[1] ?? null, config75: a.streamConfigs?.[2] ?? null,
    } as any).instruction();
  }
  /** Returns the instruction plus the placeholder keypair that must sign; the ST mint keypair signs too. */
  async createVault(a: { depositor: PublicKey; stMint: PublicKey; policy: RoutingPolicy }) {
    const vault = this.vault(a.stMint);
    const placeholder = Keypair.generate();
    const ix = await this.program.methods.createVault(a.policy).accountsPartial({
      vault, stMint: a.stMint, depositor: a.depositor, wsolMint: NATIVE_MINT,
      depositorWsol: getAssociatedTokenAddressSync(NATIVE_MINT, a.depositor),
      incomeWsol: getAssociatedTokenAddressSync(NATIVE_MINT, vault, true),
      placeholderWsol: placeholder.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    return { ix, vault, placeholder, incomeWsol: getAssociatedTokenAddressSync(NATIVE_MINT, vault, true), depositorWsol: getAssociatedTokenAddressSync(NATIVE_MINT, a.depositor) };
  }
  async depositPosition(a: { vault: PublicKey; depositor: PublicKey; streamIndex: number; dammPool: PublicKey; position: PublicKey; nftMint: PublicKey; nftAccount: PublicKey; baseMint: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.depositPosition().accountsPartial({
      vault: a.vault, depositor: a.depositor, stream: deriveStream(a.vault, a.streamIndex), streamIndex: deriveStreamIndex(a.position),
      dammPool: a.dammPool, position: a.position, nftMint: a.nftMint, nftAccount: a.nftAccount, baseMint: a.baseMint,
      cpAmmProgram: DAMM_V2_PROGRAM_ID, cpAmmEventAuthority: CP_AMM_EVENT_AUTHORITY, systemProgram: SystemProgram.programId,
    }).instruction();
  }
  /** PreBondingCurve rights only (the creator position registers after the external migration). */
  async depositDbcRights(a: { vault: PublicKey; depositor: PublicKey; streamIndex: number; dbcPool: PublicKey; dbcConfig: PublicKey; baseMint: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.depositDbcRights().accountsPartial({
      vault: a.vault, depositor: a.depositor, stream: deriveStream(a.vault, a.streamIndex), streamIndex: deriveStreamIndex(a.dbcPool),
      dbcPool: a.dbcPool, dbcConfig: a.dbcConfig, baseMint: a.baseMint, systemProgram: SystemProgram.programId,
    }).instruction();
  }
  /** CreatedPool rights plus the creator position, whose PDA NFT account the depositor hands to the vault in the same transaction (`handPositionNftToVaultIx`). */
  async depositDbcRightsMigrated(a: { vault: PublicKey; depositor: PublicKey; streamIndex: number; dbcPool: PublicKey; dbcConfig: PublicKey; baseMint: PublicKey; dammPool: PublicKey; creatorPosition: PublicKey; creatorNftAccount: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.depositDbcRightsMigrated().accountsPartial({
      vault: a.vault, depositor: a.depositor, stream: deriveStream(a.vault, a.streamIndex), streamIndex: deriveStreamIndex(a.dbcPool), creatorPositionIndex: deriveStreamIndex(a.creatorPosition),
      dbcPool: a.dbcPool, dbcConfig: a.dbcConfig, baseMint: a.baseMint, dammPool: a.dammPool, creatorPosition: a.creatorPosition, creatorNftAccount: a.creatorNftAccount,
      cpAmmProgram: DAMM_V2_PROGRAM_ID, cpAmmEventAuthority: CP_AMM_EVENT_AUTHORITY, systemProgram: SystemProgram.programId,
    }).instruction();
  }
  async registerStreamPosition(a: { vault: PublicKey; stream: PublicKey; payer: PublicKey; dbcPool: PublicKey; dbcConfig: PublicKey; dammPool: PublicKey; position: PublicKey; nftAccount: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.registerStreamPosition().accountsPartial({
      vault: a.vault, stream: a.stream, payer: a.payer, streamIndex: deriveStreamIndex(a.position), dbcPool: a.dbcPool, dbcConfig: a.dbcConfig, dammPool: a.dammPool,
      position: a.position, nftAccount: a.nftAccount, cpAmmProgram: DAMM_V2_PROGRAM_ID, cpAmmEventAuthority: CP_AMM_EVENT_AUTHORITY, systemProgram: SystemProgram.programId,
    }).instruction();
  }
  /** Returns the instruction plus the new NFT mint keypair that must sign. */
  async depositPositionSplit(a: { vault: PublicKey; depositor: PublicKey; streamIndex: number; dammPool: PublicKey; sourcePosition: PublicKey; sourceNftAccount: PublicKey; baseMint: PublicKey; permanentLockedPct: number; feeAPct: number; feeBPct: number }) {
    const newNftMint = Keypair.generate();
    const newPosition = dammPosition(newNftMint.publicKey);
    const newNftAccount = dammPositionNftAccount(newNftMint.publicKey);
    const ix = await this.program.methods.depositPositionSplit(a.permanentLockedPct, a.feeAPct, a.feeBPct).accountsPartial({
      vault: a.vault, depositor: a.depositor, stream: deriveStream(a.vault, a.streamIndex), streamIndex: deriveStreamIndex(newPosition),
      dammPool: a.dammPool, sourcePosition: a.sourcePosition, sourceNftAccount: a.sourceNftAccount, newNftMint: newNftMint.publicKey, newNftAccount, newPosition,
      cpAmmPoolAuthority: CP_AMM_POOL_AUTHORITY, baseMint: a.baseMint, cpAmmProgram: DAMM_V2_PROGRAM_ID, cpAmmEventAuthority: CP_AMM_EVENT_AUTHORITY,
      token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    return { ix, newNftMint, newPosition, newNftAccount };
  }
  /** `position` is required for a DBC-rights stream that holds a creator position (its index closes too).
   *  `depositorNftAccount` only when the NFT is not in cp-amm's PDA account; the PDA account's authority is handed back instead. */
  async withdrawStream(a: { vault: PublicKey; depositor: PublicKey; stream: PublicKey; kind: "dbc" | "position"; indexKey: PublicKey; position?: PublicKey; dbcPool?: PublicKey; dbcConfig?: PublicKey; nftAccount?: PublicKey; nftMint?: PublicKey; depositorNftAccount?: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.withdrawStream().accountsPartial({
      vault: a.vault, depositor: a.depositor, stream: a.stream, streamIndex: deriveStreamIndex(a.indexKey), streamIndexKey: a.indexKey,
      positionIndex: a.kind === "dbc" && a.position ? deriveStreamIndex(a.position) : null,
      dbcPool: a.dbcPool ?? null, dbcConfig: a.dbcConfig ?? null, dbcProgram: DBC_PROGRAM_ID, dbcEventAuthority: DBC_EVENT_AUTHORITY,
      nftAccount: a.nftAccount ?? null, nftMint: a.nftMint ?? null, depositorNftAccount: a.depositorNftAccount ?? null, token2022Program: TOKEN_2022_PROGRAM_ID,
    } as any).instruction();
  }

  decodeVault(data: Buffer): any { return this.program.coder.accounts.decode("vault", data); }
  decodeStream(data: Buffer): any { return this.program.coder.accounts.decode("stream", data); }
  decodeProtocol(data: Buffer): any { return this.program.coder.accounts.decode("protocol", data); }
}

// ---- step 4: launch, pair registration, own position, cash-out ----
export const DBC_POOL_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], DBC_PROGRAM_ID)[0];
export const METAPLEX_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
export function dbcPoolAddress(config: PublicKey, baseMint: PublicKey, quoteMint: PublicKey): PublicKey {
  const [lo, hi] = baseMint.toBuffer().compare(quoteMint.toBuffer()) < 0 ? [baseMint, quoteMint] : [quoteMint, baseMint];
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), config.toBuffer(), hi.toBuffer(), lo.toBuffer()], DBC_PROGRAM_ID)[0];
}
export function dbcTokenVault(pool: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("token_vault"), mint.toBuffer(), pool.toBuffer()], DBC_PROGRAM_ID)[0];
}
export function mintMetadata(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()], METAPLEX_PROGRAM_ID)[0];
}

export class VaultClientStep4 extends VaultClient {
  async launch(a: { vault: PublicKey; depositor: PublicKey; stMint: PublicKey; config: PublicKey; preset: number; streamIndex: number; metadata: { name: string; symbol: string; uri: string } }) {
    const pool = dbcPoolAddress(a.config, a.stMint, NATIVE_MINT);
    const ix = await this.program.methods.launch(a.preset, a.metadata).accountsPartial({
      protocol: this.protocol, vault: a.vault, depositor: a.depositor, stMint: a.stMint, config: a.config, pool, dbcPoolAuthority: DBC_POOL_AUTHORITY,
      baseVault: dbcTokenVault(pool, a.stMint), quoteVault: dbcTokenVault(pool, NATIVE_MINT), mintMetadata: mintMetadata(a.stMint), metadataProgram: METAPLEX_PROGRAM_ID,
      wsolMint: NATIVE_MINT, stream: deriveStream(a.vault, a.streamIndex), streamIndex: deriveStreamIndex(pool), stAta: getAssociatedTokenAddressSync(a.stMint, a.vault, true),
      dbcProgram: DBC_PROGRAM_ID, dbcEventAuthority: DBC_EVENT_AUTHORITY, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    return { ix, pool, stAta: getAssociatedTokenAddressSync(a.stMint, a.vault, true) };
  }
  /** `signer` is the keeper or the depositor. */
  async registerPair(a: { vault: PublicKey; signer: PublicKey; lbPair: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.registerPair().accountsPartial({ protocol: this.protocol, vault: a.vault, signer: a.signer, lbPair: a.lbPair }).instruction();
  }
  async registerOwnPosition(a: { vault: PublicKey; payer: PublicKey; streamIndex: number; dbcPool: PublicKey; dbcConfig: PublicKey; dammPool: PublicKey; position: PublicKey; nftAccount: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.registerOwnPosition().accountsPartial({
      vault: a.vault, payer: a.payer, stream: deriveStream(a.vault, a.streamIndex), streamIndex: deriveStreamIndex(a.position), dbcPool: a.dbcPool, dbcConfig: a.dbcConfig, dammPool: a.dammPool,
      position: a.position, nftAccount: a.nftAccount, cpAmmProgram: DAMM_V2_PROGRAM_ID, cpAmmEventAuthority: CP_AMM_EVENT_AUTHORITY, systemProgram: SystemProgram.programId,
    }).instruction();
  }
  async cashout(a: { vault: PublicKey; dbcPool: PublicKey; dbcConfig: PublicKey; quoteVault: PublicKey; depositorWsol: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.cashout().accountsPartial({
      vault: a.vault, dbcPool: a.dbcPool, dbcConfig: a.dbcConfig, dbcPoolAuthority: DBC_POOL_AUTHORITY, quoteVault: a.quoteVault, wsolMint: NATIVE_MINT, depositorWsol: a.depositorWsol,
      dbcProgram: DBC_PROGRAM_ID, dbcEventAuthority: DBC_EVENT_AUTHORITY, tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction();
  }
}

// ---- step 5: harvests ----
export class VaultClientStep5 extends VaultClientStep4 {
  private common(a: { vault: PublicKey; stream: PublicKey; incomeWsol: PublicKey; placeholderWsol: PublicKey; depositorWsol: PublicKey; treasury: PublicKey }) {
    return { protocol: this.protocol, vault: a.vault, stream: a.stream, incomeWsol: a.incomeWsol, placeholderWsol: a.placeholderWsol, depositorWsol: a.depositorWsol, treasury: a.treasury, wsolMint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ID };
  }
  /** `baseTokenProgram` is the base mint's owner (SPL by default; Token-2022 for 2022 bases). */
  async harvestDbc(a: { vault: PublicKey; stream: PublicKey; incomeWsol: PublicKey; placeholderWsol: PublicKey; depositorWsol: PublicKey; treasury: PublicKey; dbcPool: PublicKey; baseVault: PublicKey; quoteVault: PublicKey; baseMint: PublicKey; baseTokenProgram?: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.harvestDbc().accountsPartial({ common: this.common(a), dbcPool: a.dbcPool, dbcPoolAuthority: DBC_POOL_AUTHORITY, baseVault: a.baseVault, quoteVault: a.quoteVault, baseMint: a.baseMint, baseTokenProgram: a.baseTokenProgram ?? TOKEN_PROGRAM_ID, dbcProgram: DBC_PROGRAM_ID, dbcEventAuthority: DBC_EVENT_AUTHORITY } as any).instruction();
  }
  /** `dammPool` is the stream's recorded DAMM v2 pool (the derived pool for DBC-rights streams); `tokenAProgram` is token A's owner. */
  async harvestPosition(a: { vault: PublicKey; stream: PublicKey; incomeWsol: PublicKey; placeholderWsol: PublicKey; depositorWsol: PublicKey; treasury: PublicKey; dammPool: PublicKey; position: PublicKey; nftAccount: PublicKey; tokenAVault: PublicKey; tokenBVault: PublicKey; tokenAMint: PublicKey; tokenAProgram?: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.harvestPosition().accountsPartial({ common: this.common(a), dammPool: a.dammPool, position: a.position, nftAccount: a.nftAccount, cpAmmPoolAuthority: CP_AMM_POOL_AUTHORITY, tokenAVault: a.tokenAVault, tokenBVault: a.tokenBVault, tokenAMint: a.tokenAMint, tokenAProgram: a.tokenAProgram ?? TOKEN_PROGRAM_ID, cpAmmProgram: DAMM_V2_PROGRAM_ID, cpAmmEventAuthority: CP_AMM_EVENT_AUTHORITY } as any).instruction();
  }
  async harvestOneTime(a: { vault: PublicKey; stream: PublicKey; incomeWsol: PublicKey; placeholderWsol: PublicKey; depositorWsol: PublicKey; treasury: PublicKey; dbcPool: PublicKey; dbcConfig: PublicKey; quoteVault: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.harvestOneTime().accountsPartial({ common: this.common(a), dbcPool: a.dbcPool, dbcConfig: a.dbcConfig, dbcPoolAuthority: DBC_POOL_AUTHORITY, quoteVault: a.quoteVault, dbcProgram: DBC_PROGRAM_ID, dbcEventAuthority: DBC_EVENT_AUTHORITY } as any).instruction();
  }
}

// ---- step 6: route and settle ----
export const DLMM_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DLMM_PROGRAM_ID)[0];
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export function dlmmBinArray(pair: PublicKey, binId: number): PublicKey {
  const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(Math.floor(binId / 70)));
  return PublicKey.findProgramAddressSync([Buffer.from("bin_array"), pair.toBuffer(), b], DLMM_PROGRAM_ID)[0];
}
export function binArrayMetas(pair: PublicKey, binIds: number[]) {
  return Array.from(new Set(binIds.map((id) => dlmmBinArray(pair, id).toBase58()))).map((k) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: true }));
}

export class VaultClientStep6 extends VaultClientStep5 {
  /** Returns the instruction and the fresh order keypair that must sign. */
  async route(a: { vault: PublicKey; keeper: PublicKey; lbPair: PublicKey; reserve: PublicKey; incomeWsol: PublicKey; bins: { id: number; amount: BN }[] }) {
    const limitOrder = Keypair.generate();
    const ix = await this.program.methods.route(a.bins).accountsPartial({
      protocol: this.protocol, vault: a.vault, keeper: a.keeper, lbPair: a.lbPair, reserve: a.reserve, wsolMint: NATIVE_MINT, limitOrder: limitOrder.publicKey,
      orderRecord: deriveOrderRecord(a.vault, limitOrder.publicKey), incomeWsol: a.incomeWsol, dlmmProgram: DLMM_PROGRAM_ID, dlmmEventAuthority: DLMM_EVENT_AUTHORITY,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).remainingAccounts(binArrayMetas(a.lbPair, a.bins.map((b) => b.id))).instruction();
    return { ix, limitOrder };
  }
  async settle(a: { vault: PublicKey; signer: PublicKey; lbPair: PublicKey; reserveX: PublicKey; reserveY: PublicKey; limitOrder: PublicKey; incomeWsol: PublicKey; stAta: PublicKey; stMint: PublicKey; bins: number[] }): Promise<TransactionInstruction> {
    return this.program.methods.settle(a.bins).accountsPartial({
      protocol: this.protocol, vault: a.vault, signer: a.signer, lbPair: a.lbPair, reserveX: a.reserveX, reserveY: a.reserveY, limitOrder: a.limitOrder,
      orderRecord: deriveOrderRecord(a.vault, a.limitOrder), incomeWsol: a.incomeWsol, stAta: a.stAta, stMint: a.stMint, wsolMint: NATIVE_MINT,
      memoProgram: MEMO_PROGRAM_ID, dlmmProgram: DLMM_PROGRAM_ID, dlmmEventAuthority: DLMM_EVENT_AUTHORITY, tokenProgram: TOKEN_PROGRAM_ID,
    }).remainingAccounts(binArrayMetas(a.lbPair, a.bins)).instruction();
  }
  decodeOrderRecord(data: Buffer): any { return this.program.coder.accounts.decode("orderRecord", data); }
}
