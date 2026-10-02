// The deposit rules, mirrored for the wizard and the Sky (programs/cometail_vault/src/instructions/eligibility.rs).
// These are preflight checks on what the program will read; the program enforces them.
import { Connection, PublicKey } from "@solana/web3.js";
import { AccountLayout, ExtensionType, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, getExtensionTypes, unpackMint } from "@solana/spl-token";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

export function dbcRightsReasons(config: any, state: any): string[] {
  const r: string[] = [];
  if (!new PublicKey(config.quoteMint).equals(NATIVE_MINT)) r.push("quote is not WSOL");
  if (Number(config.collectFeeMode) !== 0) r.push("fees not collected in quote");
  if (Number(config.migrationOption) !== 1) r.push("not a DAMM v2 migration");
  if (![0, 2].includes(Number(config.migratedCollectFeeMode))) r.push("migrated pool collects fees in both tokens");
  if (Number(config.creatorPermanentLockedLiquidityPercentage) === 0) r.push("creator liquidity not permanently locked");
  if (Number(config.creatorLiquidityPercentage) !== 0) r.push("creator liquidity migrates unlocked");
  if (Number(config.creatorLiquidityVestingInfo?.vestingPercentage ?? 0) !== 0) r.push("creator liquidity vests");
  if (Number(config.migrationFeeOption) > 6) r.push("unknown migration fee option");
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

/** The base mint as the program reads it: SPL or Token-2022 with metadata extensions only, no freeze authority. Also returns its decimals. */
export async function mintReasons(connection: Connection, mint: PublicKey): Promise<{ reasons: string[]; decimals: number }> {
  const info = await connection.getAccountInfo(mint);
  if (!info) return { reasons: ["base mint missing"], decimals: 0 };
  const program = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  try {
    const m = unpackMint(mint, info, program);
    const reasons: string[] = [];
    if (m.freezeAuthority) reasons.push("base mint has a freeze authority");
    if (program.equals(TOKEN_2022_PROGRAM_ID) && getExtensionTypes(m.tlvData).some((e) => e !== ExtensionType.MetadataPointer && e !== ExtensionType.TokenMetadata)) reasons.push("base mint has non-metadata extensions");
    return { reasons, decimals: m.decimals };
  } catch { return { reasons: ["base mint unreadable"], decimals: 0 }; }
}

/** The NFT account must carry no delegate when it reaches the vault. */
export async function nftAccountReasons(connection: Connection, nftAccount: PublicKey): Promise<string[]> {
  const info = await connection.getAccountInfo(nftAccount);
  if (!info) return ["position NFT account missing"];
  const acc = AccountLayout.decode(info.data);
  return acc.delegateOption ? ["position NFT has a delegate (revoke it first)"] : [];
}

/** The size rules of the program for a migrated creator position (external stream), so the
 *  wizard picks the right position among several in the same pool: C > P: 2A >= T and 8A(C+P) <= 9TC;
 *  C <= P: 2A(C+P) >= TC and 8A(C+P) <= 9TC. */
export function creatorPositionQualifies(poolState: any, positionState: any, creatorPct: number, partnerPct: number): boolean {
  const A = BigInt(positionState.permanentLockedLiquidity.toString());
  const T = BigInt(poolState.permanentLockLiquidity.toString());
  const C = BigInt(creatorPct), P = BigInt(partnerPct), S = C + P;
  if (C === 0n) return false;
  const lower = C > P ? 2n * A >= T : 2n * A * S >= T * C;
  const upper = 8n * A * S <= 9n * T * C;
  return lower && upper;
}
