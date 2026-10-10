// Coins paired with $COMETAIL: launched on a DBC config whose quote is $COMETAIL, graduating into a coin/$COMETAIL
// DAMM v2 pool. Buyers pay SOL: one transaction swaps SOL to $COMETAIL on $COMETAIL's own pinned pool, then trades
// the coin. A buy takes exactly the $COMETAIL the second leg spends (exact out on the $COMETAIL pool, capped at the
// SOL typed), so nothing is left over; a sell to SOL swaps the second leg's guaranteed minimum, so the slippage
// margin, if any, stays in the wallet as $COMETAIL. Both legs carry their own bound; either failing fails both.
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { CpAmm, SwapMode as DammSwapMode, getTokenProgram } from "@meteora-ag/cp-amm-sdk";
import { SwapMode, getCurrentPoint } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { ADDRESSES, COMETAIL_POOL, OFFICIAL_MINT } from "./addresses";
import { dbcClient, type PoolView } from "./dbc";

export const PAIRED_DECIMALS = 6;
/** The $COMETAIL mint and its pinned SOL pool, when this build has both. */
export function pairedSetup(): { mint: PublicKey; pool: PublicKey; config: PublicKey | null } | null {
  return OFFICIAL_MINT && COMETAIL_POOL ? { mint: OFFICIAL_MINT, pool: COMETAIL_POOL, config: ADDRESSES.presets.paired } : null;
}
export const isPairedQuote = (quoteMint: PublicKey | string | null | undefined) =>
  !!quoteMint && !!OFFICIAL_MINT && (typeof quoteMint === "string" ? quoteMint : quoteMint.toBase58()) === OFFICIAL_MINT.toBase58();

/** $COMETAIL's pinned pool, checked: token A $COMETAIL, token B SOL, both under the classic token program. */
async function cometailPool(connection: Connection) {
  const setup = pairedSetup();
  if (!setup) throw new Error("this site has no $COMETAIL mint or pool configured");
  const amm = new CpAmm(connection);
  const state: any = await amm.fetchPoolState(setup.pool);
  if (!state.tokenAMint.equals(setup.mint) || !state.tokenBMint.equals(NATIVE_MINT)) throw new Error("the pinned $COMETAIL pool is not $COMETAIL/SOL");
  return { amm, state, pool: setup.pool, mint: setup.mint };
}

/** SOL per whole $COMETAIL at the pinned pool's current price (display only). */
export async function cometailSolPrice(connection: Connection): Promise<number> {
  const { state } = await cometailPool(connection);
  const sqrt = Number(BigInt(state.sqrtPrice.toString())) / 2 ** 64;
  return sqrt * sqrt * 10 ** (PAIRED_DECIMALS - 9);
}

/** A DAMM v2 pool's current point: the slot, or the slot's time (the clock when an RPC has no block time for it yet). */
async function dammPoint(connection: Connection, activationType: number): Promise<BN> {
  const slot = await connection.getSlot("confirmed");
  if (activationType === 0) return new BN(slot);
  const time = await connection.getBlockTime(slot).catch(() => null);
  return new BN(time ?? Math.floor(Date.now() / 1000));
}
async function dammLeg(connection: Connection, amm: CpAmm, pool: PublicKey, state: any, decimals: { a: number; b: number }) {
  const point = await dammPoint(connection, Number(state.activationType));
  // getQuote2 takes its slippage in basis points (the older getQuote took a percentage)
  const quote = (p: { swapMode: DammSwapMode.ExactIn; amountIn: BN } | { swapMode: DammSwapMode.ExactOut; amountOut: BN }, inputTokenMint: PublicKey, slippageBps: number): any =>
    amm.getQuote2({ ...p, inputTokenMint, slippage: slippageBps, poolState: state, currentPoint: point, tokenADecimal: decimals.a, tokenBDecimal: decimals.b, hasReferral: false } as any);
  const accounts = (inputTokenMint: PublicKey) => ({
    pool, inputTokenMint, outputTokenMint: inputTokenMint.equals(state.tokenAMint) ? state.tokenBMint : state.tokenAMint,
    tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault,
    tokenAProgram: getTokenProgram(state.tokenAFlag), tokenBProgram: getTokenProgram(state.tokenBFlag), referralTokenAccount: null, poolState: state,
  });
  return { quote, accounts };
}

/** The coin's market: its curve until it graduates, then its coin/$COMETAIL DAMM v2 pool. */
export type PairedMarket = { kind: "curve"; view: PoolView } | { kind: "damm"; pool: PublicKey; baseMint: PublicKey; baseDecimals: number };

export interface PairedPlan {
  instructions: TransactionInstruction[];
  /** SOL in (buy: at most; sell: none), $COMETAIL through the middle, coin out or in, SOL out (sell to SOL: at least). */
  solMaxIn: BN | null; cometail: BN; coinOut: BN | null; coinMinOut: BN | null; coinIn: BN | null;
  cometailOut: BN | null; cometailMinOut: BN | null; solOut: BN | null; solMinOut: BN | null;
  /** $COMETAIL that stays in the wallet at worst (a sell to SOL keeps the slippage margin). */
  cometailKept: BN;
  /** A buy that completes the curve (it buys only what the curve still takes), or comes close enough that another buy
   *  landing first could complete it: then the curve takes less and the rest stays in the wallet as $COMETAIL. */
  nearCompletion: boolean;
}

/** Drop a repeated associated-token-account create (both SDKs add one for the shared $COMETAIL account). */
function dedupe(ixs: TransactionInstruction[]): TransactionInstruction[] {
  const seen = new Set<string>();
  return ixs.filter((ix) => {
    if (!ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return true;
    const k = ix.keys[1]?.pubkey.toBase58() ?? "";
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

const bps = (x: BN, b: number) => x.muln(10_000 - b).divn(10_000);

/** Buy with SOL: exactly the $COMETAIL the coin leg spends, for at most `solIn`; the coin leg's own bound. */
export async function pairedBuy(connection: Connection, owner: PublicKey, market: PairedMarket, solIn: BN, slippageBps = 100): Promise<PairedPlan> {
  const c = await cometailPool(connection);
  const leg1 = await dammLeg(connection, c.amm, c.pool, c.state, { a: PAIRED_DECIMALS, b: 9 });
  // what solIn buys now, less the margin: that is the $COMETAIL bought exactly, paid with at most solIn
  const ahead = leg1.quote({ swapMode: DammSwapMode.ExactIn, amountIn: solIn }, NATIVE_MINT, slippageBps);
  let cometail = bps(new BN(ahead.outputAmount.toString()), slippageBps);
  if (cometail.lten(0)) throw new Error("amount too small to buy any $COMETAIL");
  let second: TransactionInstruction[], coinOut: BN, coinMinOut: BN, nearCompletion = false;
  if (market.kind === "curve") {
    const v = market.view;
    const point = await getCurrentPoint(connection, Number(v.config.activationType));
    const quote = (amountIn: BN): any => dbcClient(connection).pool.swapQuote2({ virtualPool: v.raw, config: v.config, swapBaseForQuote: false, slippageBps, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint: point, swapMode: SwapMode.PartialFill, amountIn });
    let q = quote(cometail);
    // a buy that completes the curve: the curve takes only what it still needs, fee included (amountLeft is counted
    // after the fee, includedFeeInputAmount is what the swap takes), so buy exactly that much $COMETAIL
    if (new BN(q.amountLeft?.toString() ?? "0").gtn(0)) {
      cometail = new BN(q.includedFeeInputAmount.toString());
      q = quote(cometail);
      nearCompletion = true;
    }
    // within twice this buy of completing: another buy landing first could complete it and leave $COMETAIL unspent
    const remaining = new BN(v.threshold.toString()).sub(new BN(v.quoteReserve.toString()));
    if (remaining.lte(cometail.muln(2))) nearCompletion = true;
    coinOut = new BN(q.outputAmount.toString()); coinMinOut = new BN(q.minimumAmountOut.toString());
    second = (await dbcClient(connection).pool.swap2({ owner, pool: v.pool, swapBaseForQuote: false, referralTokenAccount: null, swapMode: SwapMode.PartialFill, amountIn: cometail, minimumAmountOut: coinMinOut })).instructions;
  } else {
    const state: any = await c.amm.fetchPoolState(market.pool);
    if (!state.tokenBMint.equals(c.mint)) throw new Error("this pool is not paired with $COMETAIL");
    const leg2 = await dammLeg(connection, c.amm, market.pool, state, { a: market.baseDecimals, b: PAIRED_DECIMALS });
    const q = leg2.quote({ swapMode: DammSwapMode.ExactIn, amountIn: cometail }, c.mint, slippageBps);
    coinOut = new BN(q.outputAmount.toString()); coinMinOut = new BN(q.minimumAmountOut.toString());
    second = (await c.amm.swap2({ payer: owner, ...leg2.accounts(c.mint), swapMode: DammSwapMode.ExactIn, amountIn: cometail, minimumAmountOut: coinMinOut } as any)).instructions;
  }
  // the SOL leg buys exactly the $COMETAIL the coin leg spends (after any cap above)
  const first = await c.amm.swap2({ payer: owner, ...leg1.accounts(NATIVE_MINT), swapMode: DammSwapMode.ExactOut, amountOut: cometail, maximumAmountIn: solIn } as any);
  return { instructions: dedupe([...first.instructions, ...second]), solMaxIn: solIn, cometail, coinOut, coinMinOut, coinIn: null, cometailOut: null, cometailMinOut: null, solOut: null, solMinOut: null, cometailKept: new BN(0), nearCompletion };
}

/** Sell the coin for $COMETAIL, then, when `toSol`, the guaranteed $COMETAIL for SOL in the same transaction. */
export async function pairedSell(connection: Connection, owner: PublicKey, market: PairedMarket, coinIn: BN, toSol: boolean, slippageBps = 100): Promise<PairedPlan> {
  const c = await cometailPool(connection);
  let first: TransactionInstruction[], cometailOut: BN, cometailMinOut: BN;
  if (market.kind === "curve") {
    const v = market.view;
    const point = await getCurrentPoint(connection, Number(v.config.activationType));
    const q: any = dbcClient(connection).pool.swapQuote2({ virtualPool: v.raw, config: v.config, swapBaseForQuote: true, slippageBps, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint: point, swapMode: SwapMode.ExactIn, amountIn: coinIn });
    cometailOut = new BN(q.outputAmount.toString()); cometailMinOut = new BN(q.minimumAmountOut.toString());
    first = (await dbcClient(connection).pool.swap2({ owner, pool: v.pool, swapBaseForQuote: true, referralTokenAccount: null, swapMode: SwapMode.ExactIn, amountIn: coinIn, minimumAmountOut: cometailMinOut })).instructions;
  } else {
    const state: any = await c.amm.fetchPoolState(market.pool);
    if (!state.tokenBMint.equals(c.mint)) throw new Error("this pool is not paired with $COMETAIL");
    const leg = await dammLeg(connection, c.amm, market.pool, state, { a: market.baseDecimals, b: PAIRED_DECIMALS });
    const q = leg.quote({ swapMode: DammSwapMode.ExactIn, amountIn: coinIn }, state.tokenAMint, slippageBps);
    cometailOut = new BN(q.outputAmount.toString()); cometailMinOut = new BN(q.minimumAmountOut.toString());
    first = (await c.amm.swap2({ payer: owner, ...leg.accounts(state.tokenAMint), swapMode: DammSwapMode.ExactIn, amountIn: coinIn, minimumAmountOut: cometailMinOut } as any)).instructions;
  }
  const plan: PairedPlan = { instructions: first, solMaxIn: null, cometail: cometailMinOut, coinOut: null, coinMinOut: null, coinIn, cometailOut, cometailMinOut, solOut: null, solMinOut: null, cometailKept: new BN(0), nearCompletion: false };
  if (cometailMinOut.lten(0)) throw new Error("amount too small to sell");
  if (!toSol) return { ...plan, instructions: dedupe(first) };
  const leg1 = await dammLeg(connection, c.amm, c.pool, c.state, { a: PAIRED_DECIMALS, b: 9 });
  const q = leg1.quote({ swapMode: DammSwapMode.ExactIn, amountIn: cometailMinOut }, c.mint, slippageBps);
  const solMinOut = new BN(q.minimumAmountOut.toString());
  if (solMinOut.lten(0)) throw new Error("amount too small to sell for SOL");
  const second = await c.amm.swap2({ payer: owner, ...leg1.accounts(c.mint), swapMode: DammSwapMode.ExactIn, amountIn: cometailMinOut, minimumAmountOut: solMinOut } as any);
  return { ...plan, instructions: dedupe([...first, ...second.instructions]), solOut: new BN(q.outputAmount.toString()), solMinOut, cometailKept: cometailOut.sub(cometailMinOut) };
}

/** For a launch with a first buy: exactly `cometail` bought with at most `solIn`, before the pool is created. */
export async function cometailForSol(connection: Connection, owner: PublicKey, solIn: BN, slippageBps = 100): Promise<{ instructions: TransactionInstruction[]; cometail: BN }> {
  const c = await cometailPool(connection);
  const leg = await dammLeg(connection, c.amm, c.pool, c.state, { a: PAIRED_DECIMALS, b: 9 });
  const ahead = leg.quote({ swapMode: DammSwapMode.ExactIn, amountIn: solIn }, NATIVE_MINT, slippageBps);
  const cometail = bps(new BN(ahead.outputAmount.toString()), slippageBps);
  if (cometail.lten(0)) throw new Error("amount too small to buy any $COMETAIL");
  const tx = await c.amm.swap2({ payer: owner, ...leg.accounts(NATIVE_MINT), swapMode: DammSwapMode.ExactOut, amountOut: cometail, maximumAmountIn: solIn } as any);
  return { instructions: tx.instructions, cometail };
}
