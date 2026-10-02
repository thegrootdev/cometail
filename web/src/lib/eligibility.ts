// The deposit rules, mirrored for the wizard and the Sky (programs/cometail_vault/src/instructions/eligibility.rs).
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";

export function dbcRightsReasons(config: any, state: any): string[] {
  const r: string[] = [];
  if (!new PublicKey(config.quoteMint).equals(NATIVE_MINT)) r.push("quote is not WSOL");
  if (Number(config.collectFeeMode) !== 0) r.push("fees not collected in quote");
  if (Number(config.migrationOption) !== 1) r.push("not a DAMM v2 migration");
  if (![0, 2].includes(Number(config.migratedCollectFeeMode))) r.push("migrated pool collects fees in both tokens");
  if (Number(config.creatorPermanentLockedLiquidityPercentage) === 0) r.push("creator liquidity not permanently locked");
  if (Number(config.creatorLiquidityPercentage) !== 0) r.push("creator liquidity migrates unlocked");
  if (Number(config.creatorLiquidityVestingInfo?.vestingPercentage ?? 0) !== 0) r.push("creator liquidity vests");
  const progress = Number(state.migrationProgress);
  if (![0, 3].includes(progress)) r.push("waiting for migration");
  return r;
}

export function positionReasons(poolState: any, positionState: any): string[] {
  const r: string[] = [];
  if (!new PublicKey(poolState.tokenBMint).equals(NATIVE_MINT)) r.push("pool quote is not WSOL");
  if (![1, 2].includes(Number(poolState.collectFeeMode))) r.push("pool collects fees in both tokens");
  if (BigInt(positionState.permanentLockedLiquidity.toString()) === 0n) r.push("no permanently locked liquidity");
  if (BigInt(positionState.vestedLiquidity.toString()) !== 0n) r.push("vesting liquidity");
  if (BigInt(positionState.unlockedLiquidity.toString()) > 3n) r.push("withdrawable liquidity (split it first)");
  return r;
}
