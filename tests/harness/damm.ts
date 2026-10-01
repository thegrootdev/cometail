// DAMM v2 (cp-amm) builders and decoders on the pinned IDL.
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { derivePoolAuthority, derivePositionAddress, derivePositionNftAccount } from "@meteora-ag/cp-amm-sdk";
import { LiteSVM } from "litesvm";
import { dammProgram } from "./programs";

export const DAMM_POOL_AUTHORITY = derivePoolAuthority();
export { derivePositionAddress, derivePositionNftAccount };

export function getPool(svm: LiteSVM, pool: PublicKey): any {
  return dammProgram.coder.accounts.decode("pool", Buffer.from(svm.getAccount(pool)!.data));
}
export function getPosition(svm: LiteSVM, position: PublicKey): any {
  return dammProgram.coder.accounts.decode("position", Buffer.from(svm.getAccount(position)!.data));
}

export async function swapIx(svm: LiteSVM, a: { pool: PublicKey; payer: PublicKey; inputAccount: PublicKey; outputAccount: PublicKey; amountIn: BN; minOut?: BN }) {
  const p = getPool(svm, a.pool);
  return dammProgram.methods.swap({ amountIn: a.amountIn, minimumAmountOut: a.minOut ?? new BN(0) }).accountsPartial({
    poolAuthority: DAMM_POOL_AUTHORITY, pool: a.pool, payer: a.payer, inputTokenAccount: a.inputAccount, outputTokenAccount: a.outputAccount,
    tokenAVault: p.tokenAVault, tokenBVault: p.tokenBVault, tokenAMint: p.tokenAMint, tokenBMint: p.tokenBMint,
    tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
  }).remainingAccounts([{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }]).instruction();
}

export async function claimPositionFeeIx(svm: LiteSVM, a: { pool: PublicKey; position: PublicKey; signer: PublicKey; tokenAAccount: PublicKey; tokenBAccount: PublicKey; nftAccount?: PublicKey }) {
  const p = getPool(svm, a.pool); const pos = getPosition(svm, a.position);
  return dammProgram.methods.claimPositionFee().accountsPartial({
    poolAuthority: DAMM_POOL_AUTHORITY, pool: a.pool, position: a.position, tokenAAccount: a.tokenAAccount, tokenBAccount: a.tokenBAccount,
    tokenAVault: p.tokenAVault, tokenBVault: p.tokenBVault, tokenAMint: p.tokenAMint, tokenBMint: p.tokenBMint,
    positionNftAccount: a.nftAccount ?? derivePositionNftAccount(pos.nftMint), signer: a.signer, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
  }).instruction();
}

export async function createPositionIx(a: { pool: PublicKey; owner: PublicKey; payer: PublicKey; nftMint: Keypair }) {
  const position = derivePositionAddress(a.nftMint.publicKey);
  const nftAccount = derivePositionNftAccount(a.nftMint.publicKey);
  const ix = await dammProgram.methods.createPosition().accountsPartial({
    owner: a.owner, positionNftMint: a.nftMint.publicKey, positionNftAccount: nftAccount, pool: a.pool, position, poolAuthority: DAMM_POOL_AUTHORITY,
    payer: a.payer, tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction();
  return { ix, position, nftAccount };
}

export type SplitPct = { unlockedLiquidityPercentage: number; permanentLockedLiquidityPercentage: number; feeAPercentage: number; feeBPercentage: number; reward0Percentage: number; reward1Percentage: number; innerVestingLiquidityPercentage: number };
export async function splitPositionIx(a: { pool: PublicKey; first: PublicKey; firstNftAccount: PublicKey; second: PublicKey; secondNftAccount: PublicKey; firstOwner: PublicKey; secondOwner: PublicKey; pct: SplitPct }) {
  return dammProgram.methods.splitPosition({ ...a.pct, padding: new Array(16).fill(0) }).accountsPartial({
    pool: a.pool, firstPosition: a.first, firstPositionNftAccount: a.firstNftAccount, secondPosition: a.second,
    secondPositionNftAccount: a.secondNftAccount, firstOwner: a.firstOwner, secondOwner: a.secondOwner,
  }).instruction();
}

export async function updateDelegatePermissionIx(svm: LiteSVM, position: PublicKey, owner: PublicKey, permission: number) {
  const pos = getPosition(svm, position);
  return dammProgram.methods.updateDelegatePermission(permission).accountsPartial({ position, positionNftAccount: derivePositionNftAccount(pos.nftMint), owner }).instruction();
}

/** Which of the two migrated positions belongs to `owner`. */
export function findPositionOwnedBy(svm: LiteSVM, positions: PublicKey[], owner: PublicKey): { position: PublicKey; nftAccount: PublicKey; state: any } | null {
  for (const p of positions) {
    const acc = svm.getAccount(p); if (!acc) continue;
    const state = getPosition(svm, p);
    const nftAccount = derivePositionNftAccount(state.nftMint);
    const tok = svm.getAccount(nftAccount); if (!tok) continue;
    const ownerKey = new PublicKey(Buffer.from(tok.data).subarray(32, 64));
    if (ownerKey.equals(owner)) return { position: p, nftAccount, state };
  }
  return null;
}
