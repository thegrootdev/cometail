// DBC reads and transactions through Meteora's SDK, the way the launchpad front door uses them.
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { DynamicBondingCurveClient, deriveDbcPoolAddress, deriveDammV2PoolAddress, getCurrentPoint } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { ADDRESSES, DAMM_V2_CUSTOMIZABLE_CONFIG } from "./addresses";

export const MigrationProgress = { PreBondingCurve: 0, PostBondingCurve: 1, LockedVesting: 2, CreatedPool: 3 } as const;

export function dbcClient(connection: Connection) { return DynamicBondingCurveClient.create(connection, "confirmed"); }

/** The plain-launch pool of a base mint, and the DAMM v2 pool it migrates into. */
export function plainPoolOf(baseMint: PublicKey) { return deriveDbcPoolAddress(NATIVE_MINT, baseMint, ADDRESSES.plainConfig); }
export function derivedDammPool(baseMint: PublicKey) { return deriveDammV2PoolAddress(DAMM_V2_CUSTOMIZABLE_CONFIG, baseMint, NATIVE_MINT); }

export interface PoolView {
  pool: PublicKey; state: any; config: any; progress: number; creator: PublicKey; baseMint: PublicKey;
  quoteReserve: BN; threshold: BN; creatorQuoteFee: BN; tradingQuoteFee: BN; creatorFeePct: number;
}
export async function loadPool(connection: Connection, pool: PublicKey): Promise<PoolView | null> {
  const client = dbcClient(connection);
  const state: any = await client.state.getPool(pool);
  if (!state) return null;
  const config: any = await client.state.getPoolConfig(state.config);
  return {
    pool, state, config, progress: Number(state.migrationProgress), creator: state.creator, baseMint: state.baseMint,
    quoteReserve: new BN(state.quoteReserve.toString()), threshold: new BN(config.migrationQuoteThreshold.toString()),
    creatorQuoteFee: new BN(state.creatorQuoteFee.toString()), tradingQuoteFee: new BN(state.metrics.totalTradingQuoteFee.toString()),
    creatorFeePct: Number(config.creatorTradingFeePercentage),
  };
}
export async function poolsByCreator(connection: Connection, creator: PublicKey): Promise<{ pool: PublicKey; state: any }[]> {
  const client = dbcClient(connection);
  const all: any[] = await client.state.getPoolsByCreator(creator);
  return all.map((a: any) => ({ pool: a.publicKey, state: a.account }));
}

/** Quote for a curve trade; `swapBaseForQuote` sells the token. */
export async function curveQuote(connection: Connection, view: PoolView, amountIn: BN, swapBaseForQuote: boolean, slippageBps = 100) {
  const client = dbcClient(connection);
  const currentPoint = await getCurrentPoint(connection, Number(view.config.activationType));
  return client.pool.swapQuote({ virtualPool: view.state, config: view.config, swapBaseForQuote, amountIn, slippageBps, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint });
}
export async function curveSwapTx(connection: Connection, pool: PublicKey, owner: PublicKey, amountIn: BN, minimumAmountOut: BN, swapBaseForQuote: boolean): Promise<Transaction> {
  return dbcClient(connection).pool.swap({ owner, pool, amountIn, minimumAmountOut, swapBaseForQuote, referralTokenAccount: null });
}
export async function claimCreatorFeesTx(connection: Connection, pool: PublicKey, creator: PublicKey): Promise<Transaction> {
  return dbcClient(connection).creator.claimCreatorTradingFee({ creator, payer: creator, pool, maxBaseAmount: new BN(0), maxQuoteAmount: new BN("18446744073709551615") });
}
export async function launchTx(connection: Connection, a: { payer: PublicKey; baseMint: PublicKey; name: string; symbol: string; uri: string; firstBuyLamports?: BN }): Promise<Transaction> {
  const client = dbcClient(connection);
  const createPoolParam = { name: a.name, symbol: a.symbol, uri: a.uri, payer: a.payer, poolCreator: a.payer, config: ADDRESSES.plainConfig, baseMint: a.baseMint };
  if (a.firstBuyLamports && a.firstBuyLamports.gtn(0)) {
    return client.creator.createPoolWithFirstBuy({ createPoolParam, firstBuyParam: { buyer: a.payer, buyAmount: a.firstBuyLamports, minimumAmountOut: new BN(0), referralTokenAccount: null } });
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
