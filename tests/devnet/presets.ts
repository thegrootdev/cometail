// Devnet presets: the stand-in quote mints (a 6-decimal SPL mint for USDC, a metadata-only
// Token-2022 mint with 8 decimals for a tokenized stock) and the four new DBC configs (long,
// flat, stock-usdc, stock-xstock), all owned by the devnet authority. Re-runnable: every step
// is skipped once its account exists. Addresses go to configs/devnet.json under "presets".
//   cd tests && RPC=<keyed devnet rpc> ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 1000000 devnet/presets.ts
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MINT_SIZE, ExtensionType, createInitializeMintInstruction, createInitializeMetadataPointerInstruction, getMintLen } from "@solana/spl-token";
import fs from "fs";
import path from "path";
import { dbcProgram } from "../harness/programs";
import { configParams } from "../harness/dbc";

const ROOT = path.resolve(__dirname, "..", "..");
const KEYS = path.join(ROOT, "keys", "devnet");
const STATE = path.join(ROOT, "configs", "devnet.json");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const key = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, `${name}.json`), "utf8"))));
const load = () => JSON.parse(fs.readFileSync(STATE, "utf8"));
const save = (s: any) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n");
async function send(connection: Connection, ixs: TransactionInstruction[], signers: Keypair[], label: string) {
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
  console.log(`${label}: ${sig}`);
  return sig;
}
const exists = async (c: Connection, k: string | undefined) => !!k && !!(await c.getAccountInfo(new PublicKey(k)));

async function main() {
  const connection = new Connection(RPC, "confirmed");
  if ((await connection.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw new Error("not devnet");
  const admin = key("authority");
  const state = load();
  state.presets ??= {};
  state.quoteMints ??= {};
  console.log("admin", admin.publicKey.toBase58(), (await connection.getBalance(admin.publicKey)) / 1e9, "SOL");

  // 1. the USDC stand-in: a plain SPL mint, 6 decimals, mint authority the admin
  if (!(await exists(connection, state.quoteMints.usdc))) {
    const mint = Keypair.generate();
    const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
    await send(connection, [
      SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mint.publicKey, space: MINT_SIZE, lamports, programId: TOKEN_PROGRAM_ID }),
      createInitializeMintInstruction(mint.publicKey, 6, admin.publicKey, null, TOKEN_PROGRAM_ID),
    ], [admin, mint], `usdc stand-in mint ${mint.publicKey.toBase58()}`);
    state.quoteMints.usdc = mint.publicKey.toBase58();
    save(state);
  } else console.log("usdc stand-in", state.quoteMints.usdc, "(exists)");

  // 2. the stock stand-in: Token-2022 with the MetadataPointer extension only, which DBC treats
  //    as permissionless; the only difference from a badged mainnet stock is the absent badge account
  if (!(await exists(connection, state.quoteMints.stock))) {
    const mint = Keypair.generate();
    const mintLen = getMintLen([ExtensionType.MetadataPointer]);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
    await send(connection, [
      SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mint.publicKey, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
      createInitializeMetadataPointerInstruction(mint.publicKey, admin.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint.publicKey, 8, admin.publicKey, null, TOKEN_2022_PROGRAM_ID),
    ], [admin, mint], `stock stand-in mint ${mint.publicKey.toBase58()}`);
    state.quoteMints.stock = mint.publicKey.toBase58();
    save(state);
  } else console.log("stock stand-in", state.quoteMints.stock, "(exists)");

  // 3. the four configs
  process.env.COMETAIL_QUOTE_USDC = state.quoteMints.usdc;
  process.env.COMETAIL_QUOTE_STOCK = state.quoteMints.stock;
  const quoteOf: Record<string, PublicKey> = { long: NATIVE_MINT, flat: NATIVE_MINT, exp: NATIVE_MINT, "stock-usdc": new PublicKey(state.quoteMints.usdc), "stock-xstock": new PublicKey(state.quoteMints.stock) };
  for (const name of ["long", "flat", "exp", "stock-usdc", "stock-xstock"] as const) {
    if (await exists(connection, state.presets[name])) { console.log(`preset ${name}: ${state.presets[name]} (exists)`); continue; }
    const config = Keypair.generate();
    const ix = await dbcProgram.methods.createConfig(configParams(name)).accountsPartial({
      config: config.publicKey, feeClaimer: admin.publicKey, leftoverReceiver: admin.publicKey, quoteMint: quoteOf[name], payer: admin.publicKey, systemProgram: SystemProgram.programId,
    }).instruction();
    await send(connection, [ix], [admin, config], `preset ${name} ${config.publicKey.toBase58()}`);
    state.presets[name] = config.publicKey.toBase58();
    save(state);
  }
  console.log(JSON.stringify({ quoteMints: state.quoteMints, presets: state.presets }, null, 2));
}

describe("devnet presets", () => { it("creates the stand-in quote mints and the four new configs", main); });
