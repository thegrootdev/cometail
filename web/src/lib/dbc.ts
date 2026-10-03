// DBC reads and transactions through Meteora's SDK, the way the launchpad front door uses them.
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { NATIVE_MINT, unpackMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { DynamicBondingCurveClient, StateService, SwapMode, deriveDbcPoolAddress, deriveDammV2PoolAddress, getCurrentPoint } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { ADDRESSES, DAMM_V2_MIGRATION_CONFIGS } from "./addresses";

export const MigrationProgress = { PreBondingCurve: 0, PostBondingCurve: 1, LockedVesting: 2, CreatedPool: 3 } as const;

export function dbcClient(connection: Connection) { return DynamicBondingCurveClient.create(connection, "confirmed"); }

// Reads need one account coder, not every transaction service. Cache the service, never
// its account results; each call still fetches current state from the same connection.
const readers = new WeakMap<Connection, StateService>();
export function dbcState(connection: Connection) {
  let reader = readers.get(connection);
  if (!reader) { reader = new StateService(connection, "confirmed"); readers.set(connection, reader); }
  return reader;
}

/** The plain-launch pool of a base mint, and the DAMM v2 pool it migrates into. */
export function plainPoolOf(baseMint: PublicKey) { return deriveDbcPoolAddress(NATIVE_MINT, baseMint, ADDRESSES.plainConfig); }
/** The DAMM v2 pool a DBC pool migrates into, from its config's migration fee option. */
export function derivedDammPool(baseMint: PublicKey, migrationFeeOption = 6, quoteMint: PublicKey = NATIVE_MINT) { return deriveDammV2PoolAddress(DAMM_V2_MIGRATION_CONFIGS[migrationFeeOption] ?? DAMM_V2_MIGRATION_CONFIGS[6], baseMint, quoteMint); }

export interface PoolView {
  pool: PublicKey; state: any; raw: any; config: any; progress: number; creator: PublicKey; baseMint: PublicKey; migrationFeeOption: number; decimals: number;
  quoteMint: PublicKey; quoteDecimals: number;
  quoteReserve: BN; threshold: BN; creatorQuoteFee: BN; tradingQuoteFee: BN; creatorFeePct: number;
}
/** The SDK returns the account as the IDL lays it out: the fields sit under `poolState` since DBC 0.2.0. */
const inner = (x: any) => (x && x.poolState ? x.poolState : x);
export async function mintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  if (mint.equals(NATIVE_MINT)) return 9;
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info || (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID))) throw new Error("Quote mint unavailable");
  return unpackMint(mint, info, info.owner).decimals;
}
export async function loadPool(connection: Connection, pool: PublicKey): Promise<PoolView | null> {
  const client = dbcState(connection);
  const raw: any = await client.getPool(pool);
  const state: any = inner(raw);
  if (!state) return null;
  const config: any = await client.getPoolConfig(state.config);
  const quoteDecimals = await mintDecimals(connection, config.quoteMint);
  return {
    quoteMint: config.quoteMint, quoteDecimals,
    pool, state, raw, config, progress: Number(state.migrationProgress), creator: state.creator, baseMint: state.baseMint, migrationFeeOption: Number(config.migrationFeeOption), decimals: Number(config.tokenDecimal),
    quoteReserve: new BN(state.quoteReserve.toString()), threshold: new BN(config.migrationQuoteThreshold.toString()),
    creatorQuoteFee: new BN(state.creatorQuoteFee.toString()), tradingQuoteFee: new BN(state.metrics.totalTradingQuoteFee.toString()),
    creatorFeePct: Number(config.creatorTradingFeePercentage),
  };
}
export async function poolsByCreator(connection: Connection, creator: PublicKey): Promise<{ pool: PublicKey; state: any }[]> {
  const client = dbcState(connection);
  const all: any[] = await client.getPoolsByCreator(creator);
  return all.map((a: any) => ({ pool: a.publicKey, state: inner(a.account) }));
}

/** Quote for a curve trade; `swapBaseForQuote` sells the token. A buy is a partial fill, so the
 *  last buyer can complete the curve with a round amount and gets the remainder back; a sell is
 *  exact in. The SDK's quote reads the account as laid out (`virtualPool.poolState`). */
export async function curveQuote(connection: Connection, view: PoolView, amountIn: BN, swapBaseForQuote: boolean, slippageBps = 100) {
  const client = dbcClient(connection);
  const currentPoint = await getCurrentPoint(connection, Number(view.config.activationType));
  const common = { virtualPool: view.raw, config: view.config, swapBaseForQuote, slippageBps, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint };
  return client.pool.swapQuote2(swapBaseForQuote ? { ...common, swapMode: SwapMode.ExactIn, amountIn } : { ...common, swapMode: SwapMode.PartialFill, amountIn });
}
export async function curveSwapTx(connection: Connection, pool: PublicKey, owner: PublicKey, amountIn: BN, minimumAmountOut: BN, swapBaseForQuote: boolean): Promise<Transaction> {
  const common = { owner, pool, swapBaseForQuote, referralTokenAccount: null };
  return dbcClient(connection).pool.swap2(swapBaseForQuote ? { ...common, swapMode: SwapMode.ExactIn, amountIn, minimumAmountOut } : { ...common, swapMode: SwapMode.PartialFill, amountIn, minimumAmountOut });
}
export async function claimCreatorFeesTx(connection: Connection, pool: PublicKey, creator: PublicKey): Promise<Transaction> {
  return dbcClient(connection).creator.claimCreatorTradingFee({ creator, payer: creator, pool, maxBaseAmount: new BN(0), maxQuoteAmount: new BN("18446744073709551615") });
}
export async function launchTx(connection: Connection, a: { payer: PublicKey; baseMint: PublicKey; name: string; symbol: string; uri: string; firstBuyLamports?: BN; firstBuyRaw?: BN; config?: PublicKey; quoteMint?: PublicKey; quoteDecimals?: number }): Promise<Transaction> {
  const client = dbcClient(connection);
  const config = a.config ?? ADDRESSES.plainConfig;
  const configState = await dbcState(connection).getPoolConfig(config);
  const expectedQuote = a.quoteMint ?? NATIVE_MINT;
  if (!configState || !configState.quoteMint.equals(expectedQuote)) throw new Error("Launch quote does not match the selected config");
  const decimals = await mintDecimals(connection, expectedQuote);
  if (decimals !== (a.quoteDecimals ?? 9)) throw new Error("Launch quote decimals changed; review the amount again");
  const buyAmount = a.firstBuyRaw ?? a.firstBuyLamports;
  const createPoolParam = { name: a.name, symbol: a.symbol, uri: a.uri, payer: a.payer, poolCreator: a.payer, config, baseMint: a.baseMint };
  if (buyAmount && buyAmount.gtn(0)) {
    return client.creator.createPoolWithFirstBuy({ createPoolParam, firstBuyParam: { buyer: a.payer, buyAmount, minimumAmountOut: new BN(0), referralTokenAccount: null } });
  }
  return client.creator.createPool(createPoolParam);
}

/** Name, symbol and uri from the Metaplex metadata account of a mint (borsh strings, zero-padded). */
export async function readMetadata(connection: Connection, mint: PublicKey): Promise<{ name: string; symbol: string; uri: string } | null> {
  const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX);
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  const d = info.data;
  let o = 1 + 32 + 32;
  const str = () => { const len = d.readUInt32LE(o); o += 4; const s = d.subarray(o, o + len).toString("utf8").replace(/\0+$/, ""); o += len; return s; };
  try { return { name: str(), symbol: str(), uri: str() }; } catch { return null; }
}
