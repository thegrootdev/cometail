// Instruction builders for the COMETAIL vault program. Pure: no RPC, no signing.
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID, deriveProtocol, deriveVault, SEEDS } from "./index";

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
  async depositDbcRights(a: { vault: PublicKey; depositor: PublicKey; streamIndex: number; dbcPool: PublicKey; dbcConfig: PublicKey; baseMint: PublicKey; creatorPosition?: PublicKey; creatorNftAccount?: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.depositDbcRights().accountsPartial({
      vault: a.vault, depositor: a.depositor, stream: deriveStream(a.vault, a.streamIndex), streamIndex: deriveStreamIndex(a.dbcPool),
      dbcPool: a.dbcPool, dbcConfig: a.dbcConfig, baseMint: a.baseMint, creatorPosition: a.creatorPosition ?? null, creatorNftAccount: a.creatorNftAccount ?? null,
      cpAmmProgram: DAMM_V2_PROGRAM_ID, cpAmmEventAuthority: CP_AMM_EVENT_AUTHORITY, systemProgram: SystemProgram.programId,
    } as any).instruction();
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
