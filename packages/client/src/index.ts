// Program ids and PDA helpers. Instruction builders follow the program (build steps 3-6).
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
