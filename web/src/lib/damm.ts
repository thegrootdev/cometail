// DAMM v2 reads and trades through Meteora's cp-amm SDK, for graduated pools.
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { CpAmm, getUnClaimLpFee, getTokenProgram } from "@meteora-ag/cp-amm-sdk";

export function cpAmm(connection: Connection) { return new CpAmm(connection); }

export async function dammSwapTx(connection: Connection, pool: PublicKey, payer: PublicKey, inputTokenMint: PublicKey, amountIn: BN, decimals: { a: number; b: number }, slippagePct = 1): Promise<{ tx: Transaction; minOut: BN; out: BN }> {
  const amm = cpAmm(connection);
  const poolState: any = await amm.fetchPoolState(pool);
  const slot = await connection.getSlot();
  const time = await connection.getBlockTime(slot);
  const quote: any = amm.getQuote({ inAmount: amountIn, inputTokenMint, slippage: slippagePct, poolState, currentTime: time ?? Math.floor(Date.now() / 1000), currentSlot: slot, tokenADecimal: decimals.a, tokenBDecimal: decimals.b });
  const outputTokenMint = inputTokenMint.equals(poolState.tokenAMint) ? poolState.tokenBMint : poolState.tokenAMint;
  const tx = await amm.swap({
    payer, pool, inputTokenMint, outputTokenMint, amountIn, minimumAmountOut: quote.minSwapOutAmount, tokenAMint: poolState.tokenAMint, tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault, tokenAProgram: getTokenProgram(poolState.tokenAFlag), tokenBProgram: getTokenProgram(poolState.tokenBFlag), referralTokenAccount: null,
  });
  return { tx, minOut: quote.minSwapOutAmount, out: quote.swapOutAmount };
}

/** The quote alone, for the live preview while an amount is typed; the trade quotes again when sent. */
export async function dammQuote(connection: Connection, pool: PublicKey, inputTokenMint: PublicKey, amountIn: BN, decimals: { a: number; b: number }, slippagePct = 1): Promise<{ out: BN; minOut: BN }> {
  const amm = cpAmm(connection);
  const poolState: any = await amm.fetchPoolState(pool);
  const slot = await connection.getSlot();
  const time = await connection.getBlockTime(slot);
  const quote: any = amm.getQuote({ inAmount: amountIn, inputTokenMint, slippage: slippagePct, poolState, currentTime: time ?? Math.floor(Date.now() / 1000), currentSlot: slot, tokenADecimal: decimals.a, tokenBDecimal: decimals.b });
  return { out: quote.swapOutAmount, minOut: quote.minSwapOutAmount };
}

/** Claimable fees of a position right now. */
export async function pendingFees(connection: Connection, pool: PublicKey, position: PublicKey): Promise<{ feeA: BN; feeB: BN } | null> {
  const amm = cpAmm(connection);
  const [poolState, positionState]: any[] = await Promise.all([amm.fetchPoolState(pool), amm.fetchPositionState(position)]);
  if (!poolState || !positionState) return null;
  const f = getUnClaimLpFee(poolState, positionState);
  return { feeA: f.feeTokenA, feeB: f.feeTokenB };
}
