// Anchor program handles for the pinned Meteora IDLs. Instructions are built offline, so
// the provider's connection is never used.
import { AnchorProvider, Program, Wallet, Idl } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import path from "path";

const IDLS = path.resolve(__dirname, "..", "..", "idls");
const provider = new AnchorProvider(new Connection("http://127.0.0.1:8899"), new Wallet(Keypair.generate()), {});

function load(name: string): Idl {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path.join(IDLS, name)) as Idl;
}

export const dbcProgram: Program = new Program(load("dynamic_bonding_curve.json"), provider);
export const dammProgram: Program = new Program(load("cp_amm.json"), provider);
export const dlmmProgram: Program = new Program(load("lb_clmm.json"), provider);
