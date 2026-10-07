// LiteSVM bootstrap: the live mainnet Meteora binaries, the helper programs DBC migration
// needs, Meteora's live DAMM v2 migration configs (cloned read-only), WSOL, and the vault
// program from target/deploy.
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { LiteSVM } from "litesvm";
import fs from "fs";
import path from "path";

export const DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
export const DAMM_V1_PROGRAM_ID = new PublicKey("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB");
export const DYNAMIC_VAULT_PROGRAM_ID = new PublicKey("24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyQc");
export const LOCKER_PROGRAM_ID = new PublicKey("LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn");
export const METAPLEX_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
export const DBC_POOL_AUTHORITY = new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
/** Meteora's live DAMM v2 configs for DBC migrations (dynamic-bonding-curve-sdk constants). */
export const DAMM_V2_MIGRATION_CONFIG = {
  fixedBps25: new PublicKey("7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd"),
  customizable: new PublicKey("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck"),
};

const ROOT = path.resolve(__dirname, "..", "..");
const FIX = path.join(ROOT, "tests", "fixtures");

/** The program id is public: it comes from the built IDL, never from a key file. */
export function vaultProgramId(): PublicKey {
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target", "idl", "cometail_vault.json"), "utf8"));
  return new PublicKey(idl.address);
}

function setClonedAccount(svm: LiteSVM, address: PublicKey, file: string) {
  const v = JSON.parse(fs.readFileSync(path.join(FIX, "accounts", file), "utf8")).result.value;
  svm.setAccount(address, {
    data: new Uint8Array(Buffer.from(v.data[0], "base64")),
    executable: false,
    lamports: v.lamports,
    owner: new PublicKey(v.owner),
  });
}

export const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export function vaultProgramData(): PublicKey {
  return PublicKey.findProgramAddressSync([vaultProgramId().toBuffer()], UPGRADEABLE_LOADER)[0];
}
/** Install the vault program the way a cluster deploy does: an upgradeable-loader Program
 *  account pointing at a ProgramData account that carries the ELF and the upgrade authority. */
export function installVaultProgram(svm: LiteSVM, upgradeAuthority: PublicKey) {
  const id = vaultProgramId();
  const programData = vaultProgramData();
  const elf = fs.readFileSync(path.join(ROOT, "target", "deploy", "cometail_vault.so"));
  const hdr = Buffer.alloc(45);
  hdr.writeUInt32LE(3, 0); // UpgradeableLoaderState::ProgramData
  hdr.writeBigUInt64LE(BigInt(0), 4); // slot
  hdr.writeUInt8(1, 12); upgradeAuthority.toBuffer().copy(hdr, 13); // Some(authority)
  svm.setAccount(programData, { lamports: 10_000_000_000, data: new Uint8Array(Buffer.concat([hdr, elf])), owner: UPGRADEABLE_LOADER, executable: false });
  const prog = Buffer.alloc(36);
  prog.writeUInt32LE(2, 0); programData.toBuffer().copy(prog, 4); // UpgradeableLoaderState::Program
  svm.setAccount(id, { lamports: 1_000_000_000, data: new Uint8Array(prog), owner: UPGRADEABLE_LOADER, executable: true });
}

/** The burn program id, from its built IDL. */
export function burnProgramId(): PublicKey {
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target", "idl", "cometail_burn.json"), "utf8"));
  return new PublicKey(idl.address);
}
/** Install the burn program as a cluster deploy does, with `upgradeAuthority` in its ProgramData. */
export function installBurnProgram(svm: LiteSVM, upgradeAuthority: PublicKey) {
  const id = burnProgramId();
  const programData = PublicKey.findProgramAddressSync([id.toBuffer()], UPGRADEABLE_LOADER)[0];
  const elf = fs.readFileSync(path.join(ROOT, "target", "deploy", "cometail_burn.so"));
  const hdr = Buffer.alloc(45);
  hdr.writeUInt32LE(3, 0); hdr.writeBigUInt64LE(BigInt(0), 4); hdr.writeUInt8(1, 12); upgradeAuthority.toBuffer().copy(hdr, 13);
  svm.setAccount(programData, { lamports: 10_000_000_000, data: new Uint8Array(Buffer.concat([hdr, elf])), owner: UPGRADEABLE_LOADER, executable: false });
  const prog = Buffer.alloc(36);
  prog.writeUInt32LE(2, 0); programData.toBuffer().copy(prog, 4);
  svm.setAccount(id, { lamports: 1_000_000_000, data: new Uint8Array(prog), owner: UPGRADEABLE_LOADER, executable: true });
}

export function startSvm(opts: { withVaultProgram?: boolean; upgradeAuthority?: PublicKey; burnAuthority?: PublicKey } = {}): LiteSVM {
  const svm = new LiteSVM();
  const P = (f: string) => path.join(FIX, "programs", f);
  svm.addProgramFromFile(DBC_PROGRAM_ID, P("dbc_mainnet.so"));
  svm.addProgramFromFile(DAMM_V2_PROGRAM_ID, P("cp_amm_mainnet.so"));
  svm.addProgramFromFile(DLMM_PROGRAM_ID, P("lb_clmm_mainnet.so"));
  svm.addProgramFromFile(DAMM_V1_PROGRAM_ID, P("amm.so"));
  svm.addProgramFromFile(DYNAMIC_VAULT_PROGRAM_ID, P("vault.so"));
  svm.addProgramFromFile(LOCKER_PROGRAM_ID, P("locker.so"));
  svm.addProgramFromFile(METAPLEX_PROGRAM_ID, P("metaplex.so"));
  if (opts.withVaultProgram !== false) {
    if (opts.upgradeAuthority) installVaultProgram(svm, opts.upgradeAuthority);
    else svm.addProgramFromFile(vaultProgramId(), path.join(ROOT, "target", "deploy", "cometail_vault.so"));
  }
  if (opts.burnAuthority) installBurnProgram(svm, opts.burnAuthority);
  setClonedAccount(svm, DAMM_V2_MIGRATION_CONFIG.fixedBps25, "damm_v2_config_fixedbps25.json");
  setClonedAccount(svm, DAMM_V2_MIGRATION_CONFIG.customizable, "damm_v2_config_customizable.json");
  // native mint
  const mint = new Uint8Array(82);
  mint[44] = 9; mint[45] = 1;
  svm.setAccount(NATIVE_MINT, { data: mint, executable: false, lamports: 1390379946687, owner: TOKEN_PROGRAM_ID });
  // DBC's pool authority fronts rent during migration
  svm.setAccount(DBC_POOL_AUTHORITY, { lamports: 1e9, data: new Uint8Array(), owner: SystemProgram.programId, executable: false });
  // real wall-clock so timestamp-activated pools behave
  const clock = svm.getClock();
  clock.unixTimestamp = BigInt(Math.floor(Date.now() / 1000));
  svm.setClock(clock);
  return svm;
}

export function fund(svm: LiteSVM, sol = 10_000): Keypair {
  const kp = Keypair.generate();
  svm.airdrop(kp.publicKey, BigInt(sol * LAMPORTS_PER_SOL));
  return kp;
}
