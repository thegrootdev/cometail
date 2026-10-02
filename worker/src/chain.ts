// Chain readers: vault program accounts by discriminator, Meteora account decoders through
// the pinned IDLs in ../../idls, and raw limit-order parsing mirroring the program
// (programs/cometail_vault/src/instructions/ladder.rs read_limit_order).
import { AnchorProvider, BN, EventParser, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { AccountLayout } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID, VAULT_PROGRAM_ID, VaultClientStep6 , DLMM_PROGRAM_ID } from "@cometail/client";
import { derivePositionNftAccount } from "@meteora-ag/cp-amm-sdk";
import path from "path";

const IDLS = path.resolve(__dirname, "..", "..", "idls");

/** Mirrors eligibility.rs DAMM_V2_MIGRATION_CONFIGS, indexed by the DBC config's migration_fee_option. */
export const DAMM_V2_MIGRATION_CONFIGS = [
  "7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd",
  "2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k",
  "Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp",
  "2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq",
  "AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD",
  "DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u",
  "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck",
].map((k) => new PublicKey(k));

export const DBC_PROGRESS = { preBonding: 0, postBonding: 1, lockedVesting: 2, createdPool: 3 } as const;
const LIMIT_ORDER_DISCRIMINATOR = Buffer.from([137, 183, 212, 91, 115, 29, 141, 227]);

export interface LimitOrderBin { id: number; amount: bigint; isAsk: boolean; age: number }
export interface LimitOrderView { lbPair: PublicKey; owner: PublicKey; bins: LimitOrderBin[] }

export function parseLimitOrder(data: Buffer): LimitOrderView {
  if (data.length < 120 || !data.subarray(0, 8).equals(LIMIT_ORDER_DISCRIMINATOR)) throw new Error("not a limit order");
  const binCount = data.readUInt16LE(72);
  if (data.length < 120 + 32 * binCount) throw new Error("truncated limit order");
  const bins: LimitOrderBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const o = 120 + 32 * i;
    bins.push({ amount: data.readBigUInt64LE(o), age: data.readUInt32LE(o + 8), id: data.readInt32LE(o + 16), isAsk: data[o + 20] !== 0 });
  }
  return { lbPair: new PublicKey(data.subarray(8, 40)), owner: new PublicKey(data.subarray(40, 72)), bins };
}

/** The limit-order fields of one DLMM `Bin`, read from its bin array exactly as the program's
 *  settle does (ladder.rs read_bin: 8 + 48 byte header, 144-byte bins, 70 per array). */
export interface BinView { openOrderAmount: bigint; totalProcessingOrderAmount: bigint; processedOrderRemainingAmount: bigint; orderAge: number }
export const BINS_PER_ARRAY = 70;
const BIN_SIZE = 144, BIN_ARRAY_HEADER = 8 + 8 + 1 + 7 + 32;
const BIN_ARRAY_DISCRIMINATOR = Buffer.from([92, 142, 92, 220, 5, 148, 70, 181]);
export function binArrayIndex(binId: number): number { return Math.floor(binId / BINS_PER_ARRAY); }
export function deriveBinArray(pair: PublicKey, index: number): PublicKey {
  const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(index));
  return PublicKey.findProgramAddressSync([Buffer.from("bin_array"), pair.toBuffer(), b], DLMM_PROGRAM_ID)[0];
}
export function readBinView(data: Buffer, pair: PublicKey, binId: number): BinView | null {
  if (data.length < BIN_ARRAY_HEADER + BINS_PER_ARRAY * BIN_SIZE || !data.subarray(0, 8).equals(BIN_ARRAY_DISCRIMINATOR)) return null;
  if (data.readBigInt64LE(8) !== BigInt(binArrayIndex(binId))) return null;
  if (!new PublicKey(data.subarray(24, 56)).equals(pair)) return null;
  const o = BIN_ARRAY_HEADER + (((binId % BINS_PER_ARRAY) + BINS_PER_ARRAY) % BINS_PER_ARRAY) * BIN_SIZE;
  return { openOrderAmount: data.readBigUInt64LE(o + 112), totalProcessingOrderAmount: data.readBigUInt64LE(o + 120), processedOrderRemainingAmount: data.readBigUInt64LE(o + 128), orderAge: data.readUInt32LE(o + 136) };
}
/** The unfilled principal of one order bin, as DLMM's reader and the program's settle compute it
 *  (ladder.rs unfilled_amount): untouched while the bin's order age is the order's own; a partially
 *  processed generation keeps ceil(amount x processed_remaining / total_processing); two or more
 *  generations older is filled. An order age ahead of the bin's is incoherent (accounts read from
 *  mismatched slots): the program rejects it (ladder.rs:64), here it is null, unknown, never filled. */
export function unfilledAmount(orderBin: LimitOrderBin, bin: BinView): bigint | null {
  if (orderBin.age === bin.orderAge) return orderBin.amount;
  if (orderBin.age + 1 === bin.orderAge) {
    if (bin.openOrderAmount === 0n && bin.processedOrderRemainingAmount === 0n) return 0n;
    if (bin.totalProcessingOrderAmount === 0n) return 0n;
    return (orderBin.amount * bin.processedOrderRemainingAmount + bin.totalProcessingOrderAmount - 1n) / bin.totalProcessingOrderAmount;
  }
  if (orderBin.age + 2 <= bin.orderAge) return 0n;
  return null;
}

export interface Decoded<T = any> { pubkey: PublicKey; account: T }

export class Chain {
  readonly client: VaultClientStep6;
  readonly dbc: Program;
  readonly damm: Program;
  readonly dlmm: Program;
  readonly events: EventParser;

  constructor(readonly connection: Connection) {
    this.client = new VaultClientStep6(connection);
    const provider = new AnchorProvider(connection, new Wallet(Keypair.generate()), {});
    const load = (n: string) => require(path.join(IDLS, n)) as Idl;
    this.dbc = new Program(load("dynamic_bonding_curve.json"), provider);
    this.damm = new Program(load("cp_amm.json"), provider);
    this.dlmm = new Program(load("lb_clmm.json"), provider);
    this.events = new EventParser(VAULT_PROGRAM_ID, this.client.program.coder);
  }

  // ---- vault program accounts ----
  private async fetchAll(name: string, extra: { offset: number; bytes: string }[] = []): Promise<Decoded[]> {
    const disc = this.client.program.coder.accounts.memcmp(name) as { offset: number; bytes: string };
    const accounts = await this.connection.getProgramAccounts(VAULT_PROGRAM_ID, {
      filters: [{ memcmp: disc }, ...extra.map((m) => ({ memcmp: m }))],
    });
    return accounts.map((a) => ({ pubkey: a.pubkey, account: this.client.program.coder.accounts.decode(name, a.account.data) }));
  }
  async protocol(): Promise<any> {
    const info = await this.connection.getAccountInfo(this.client.protocol);
    if (!info) throw new Error("protocol not initialized");
    return this.client.decodeProtocol(info.data);
  }
  vaults(): Promise<Decoded[]> { return this.fetchAll("vault"); }
  streams(vault: PublicKey): Promise<Decoded[]> { return this.fetchAll("stream", [{ offset: 8, bytes: vault.toBase58() }]); }
  orderRecords(vault: PublicKey): Promise<Decoded[]> { return this.fetchAll("orderRecord", [{ offset: 8, bytes: vault.toBase58() }]); }
  async vault(pk: PublicKey): Promise<any> {
    const info = await this.connection.getAccountInfo(pk);
    return info ? this.client.decodeVault(info.data) : null;
  }

  // ---- Meteora accounts ----
  private async decode(program: Program, name: string, pk: PublicKey): Promise<any | null> {
    const info = await this.connection.getAccountInfo(pk);
    return info ? program.coder.accounts.decode(name, info.data) : null;
  }
  /** The DBC pool account wraps its state in `pool_state`; this returns the inner state. */
  async dbcPool(pk: PublicKey) { const d = await this.decode(this.dbc, "virtualPool", pk); return d ? d.poolState : null; }
  dbcConfig(pk: PublicKey) { return this.decode(this.dbc, "poolConfig", pk); }
  dammPool(pk: PublicKey) { return this.decode(this.damm, "pool", pk); }
  dammPosition(pk: PublicKey) { return this.decode(this.damm, "position", pk); }
  lbPair(pk: PublicKey) { return this.decode(this.dlmm, "lbPair", pk); }
  /** The bin arrays of a pair that hold the given bins, keyed by array index (null when absent). */
  async binArrays(pair: PublicKey, binIds: number[]): Promise<Map<number, Buffer | null>> {
    const indices = [...new Set(binIds.map(binArrayIndex))];
    const infos = await this.connection.getMultipleAccountsInfo(indices.map((i) => deriveBinArray(pair, i)), "confirmed");
    return new Map(indices.map((i, j) => [i, infos[j] ? infos[j]!.data : null]));
  }
  async limitOrder(pk: PublicKey): Promise<LimitOrderView | null> {
    const info = await this.connection.getAccountInfo(pk);
    return info ? parseLimitOrder(info.data) : null;
  }

  // ---- token accounts ----
  async tokenBalance(pk: PublicKey): Promise<bigint> {
    const info = await this.connection.getAccountInfo(pk);
    return info ? AccountLayout.decode(info.data).amount : 0n;
  }
  /** The program that owns an account (a mint's token program). */
  async accountOwner(pk: PublicKey): Promise<PublicKey | null> {
    const info = await this.connection.getAccountInfo(pk);
    return info ? info.owner : null;
  }
  async tokenOwner(pk: PublicKey): Promise<PublicKey | null> {
    const info = await this.connection.getAccountInfo(pk);
    return info ? new PublicKey(AccountLayout.decode(info.data).owner) : null;
  }

  /** DAMM v2 positions of a pool whose NFT is held by `owner` (the vault PDA after a migration). */
  async positionsOwnedBy(pool: PublicKey, owner: PublicKey): Promise<{ position: PublicKey; nftAccount: PublicKey; state: any }[]> {
    const disc = this.damm.coder.accounts.memcmp("position") as { offset: number; bytes: string };
    const accounts = await this.connection.getProgramAccounts(DAMM_V2_PROGRAM_ID, {
      filters: [{ memcmp: disc }, { memcmp: { offset: 8, bytes: pool.toBase58() } }],
    });
    const out: { position: PublicKey; nftAccount: PublicKey; state: any }[] = [];
    for (const a of accounts) {
      const state = this.damm.coder.accounts.decode("position", a.account.data);
      const nftAccount = derivePositionNftAccount(state.nftMint);
      const holder = await this.tokenOwner(nftAccount);
      if (holder && holder.equals(owner)) out.push({ position: a.pubkey, nftAccount, state });
    }
    return out;
  }
}

export const isDefault = (pk: PublicKey) => pk.equals(PublicKey.default);
export const bn = (v: bigint | number) => new BN(v.toString());
export const big = (v: BN | number | bigint) => BigInt(v.toString());
export { DBC_PROGRAM_ID, DAMM_V2_PROGRAM_ID };
