import {
  AccountLayout, MINT_SIZE, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction, createMintToInstruction,
  createSyncNativeInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { LiteSVM } from "litesvm";
import { send } from "./tx";

export function createMint(svm: LiteSVM, payer: Keypair, decimals: number, authority = payer.publicKey): PublicKey {
  const mint = Keypair.generate();
  const lamports = Number(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE)));
  send(svm, [
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(mint.publicKey, decimals, authority, null),
  ], [payer, mint]);
  return mint.publicKey;
}

export function ata(mint: PublicKey, owner: PublicKey, tokenProgram = TOKEN_PROGRAM_ID): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
}
export function ataIx(payer: PublicKey, mint: PublicKey, owner: PublicKey, tokenProgram = TOKEN_PROGRAM_ID) {
  const address = ata(mint, owner, tokenProgram);
  return { address, ix: createAssociatedTokenAccountIdempotentInstruction(payer, address, owner, mint, tokenProgram) };
}
export function ensureAta(svm: LiteSVM, payer: Keypair, mint: PublicKey, owner: PublicKey, tokenProgram = TOKEN_PROGRAM_ID): PublicKey {
  const { address, ix } = ataIx(payer.publicKey, mint, owner, tokenProgram);
  if (!svm.getAccount(address)) send(svm, [ix], [payer]);
  return address;
}
export function mintTo(svm: LiteSVM, payer: Keypair, mint: PublicKey, owner: PublicKey, amount: BN | number, authority = payer) {
  const dest = ensureAta(svm, payer, mint, owner);
  send(svm, [createMintToInstruction(mint, dest, authority.publicKey, BigInt(amount.toString()))], [payer, authority]);
  return dest;
}
/** Wrap SOL for `owner` by transferring lamports into its WSOL ATA and syncing. */
export function wrapSol(svm: LiteSVM, owner: Keypair, lamports: BN | number): PublicKey {
  const dest = ensureAta(svm, owner, NATIVE_MINT, owner.publicKey);
  send(svm, [
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: dest, lamports: BigInt(lamports.toString()) }),
    createSyncNativeInstruction(dest),
  ], [owner]);
  return dest;
}
export function balance(svm: LiteSVM, tokenAccount: PublicKey): BN {
  const a = svm.getAccount(tokenAccount);
  if (!a) return new BN(0);
  return new BN(AccountLayout.decode(Buffer.from(a.data)).amount.toString());
}
export function tokenOwner(svm: LiteSVM, tokenAccount: PublicKey): PublicKey {
  return AccountLayout.decode(Buffer.from(svm.getAccount(tokenAccount)!.data)).owner;
}
export { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, LAMPORTS_PER_SOL };

/** A Token-2022 mint, optionally with a freeze authority. */
export function createMint2022(svm: LiteSVM, payer: Keypair, decimals: number, freezeAuthority: PublicKey | null = null): PublicKey {
  const mint = Keypair.generate();
  const lamports = Number(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE)));
  send(svm, [
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports, space: MINT_SIZE, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMint2Instruction(mint.publicKey, decimals, payer.publicKey, freezeAuthority, TOKEN_2022_PROGRAM_ID),
  ], [payer, mint]);
  return mint.publicKey;
}
export function mintTo2022(svm: LiteSVM, payer: Keypair, mint: PublicKey, owner: PublicKey, amount: BN | number) {
  const dest = ensureAta(svm, payer, mint, owner, TOKEN_2022_PROGRAM_ID);
  send(svm, [createMintToInstruction(mint, dest, payer.publicKey, BigInt(amount.toString()), [], TOKEN_2022_PROGRAM_ID)], [payer]);
  return dest;
}
