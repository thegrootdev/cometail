// Program ids and PDA seeds, with no imports of their own: everything else in the package
// imports from here, so there is no cycle between the builders and the index.
import { PublicKey } from "@solana/web3.js";

export const DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

export const SEEDS = {
  protocol: Buffer.from("protocol"),
  vault: Buffer.from("vault"),
  stream: Buffer.from("stream"),
  streamIndex: Buffer.from("stream-index"),
  order: Buffer.from("order"),
};

export function deriveProtocol(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEEDS.protocol], programId);
}

export function deriveVault(programId: PublicKey, stMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEEDS.vault, stMint.toBuffer()], programId);
}
