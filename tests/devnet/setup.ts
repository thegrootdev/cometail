// Devnet setup after `solana program deploy`: the admin's WSOL treasury ATA, the four DBC
// configs (three stream presets and the plain launch config), init_protocol, and funding of
// the keeper / depositor / buyer keys. Re-runnable: every step is skipped once its account
// exists. Addresses go to configs/devnet.json (public devnet addresses; no keys).
//   RPC=https://api.devnet.solana.com ts-node devnet/setup.ts [fund]
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import fs from "fs";
import path from "path";
import { VaultClientStep6, VAULT_PROGRAM_ID } from "@cometail/client";
import { dbcProgram } from "../harness/programs";
import { configParams } from "../harness/dbc";

const ROOT = path.resolve(__dirname, "..", "..");
const KEYS = path.join(ROOT, "keys", "devnet");
const STATE = path.join(ROOT, "configs", "devnet.json");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const FUND = { keeper: 2, depositor: 3, buyer: 3 } as Record<string, number>; // SOL targets

function key(name: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, `${name}.json`), "utf8"))));
}
function loadState(): any { return fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { cluster: "devnet", configs: {} }; }
function saveState(s: any) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n"); }

async function send(connection: Connection, ixs: TransactionInstruction[], signers: Keypair[], label: string) {
  const tx = new Transaction().add(...ixs);
  const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
  console.log(`${label}: ${sig}`);
  return sig;
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const admin = key("authority");
  const keeper = key("keeper");
  const state = loadState();
  state.programId = VAULT_PROGRAM_ID.toBase58();
  state.admin = admin.publicKey.toBase58();
  state.keeper = keeper.publicKey.toBase58();
  const program = await connection.getAccountInfo(VAULT_PROGRAM_ID);
  if (!program || !program.executable) throw new Error(`program ${VAULT_PROGRAM_ID.toBase58()} is not deployed on ${RPC}`);
  console.log("admin balance", (await connection.getBalance(admin.publicKey)) / LAMPORTS_PER_SOL, "SOL");

  // 1. treasury: the admin's WSOL ATA
  const treasury = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
  if (!(await connection.getAccountInfo(treasury))) {
    await send(connection, [createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, treasury, admin.publicKey, NATIVE_MINT)], [admin], "treasury ata");
  }
  state.treasury = treasury.toBase58();

  // 2. configs
  for (const name of ["stream-25", "stream-50", "stream-75", "plain"] as const) {
    if (state.configs[name] && (await connection.getAccountInfo(new PublicKey(state.configs[name])))) { console.log(`config ${name}: ${state.configs[name]} (exists)`); continue; }
    const config = Keypair.generate();
    const ix = await dbcProgram.methods.createConfig(configParams(name)).accountsPartial({
      config: config.publicKey, feeClaimer: admin.publicKey, leftoverReceiver: admin.publicKey, quoteMint: NATIVE_MINT, payer: admin.publicKey, systemProgram: SystemProgram.programId,
    }).instruction();
    await send(connection, [ix], [admin, config], `config ${name} ${config.publicKey.toBase58()}`);
    state.configs[name] = config.publicKey.toBase58();
    saveState(state);
  }

  // 3. init_protocol (admin = the program's upgrade authority)
  const client = new VaultClientStep6(connection);
  state.protocol = client.protocol.toBase58();
  if (!(await connection.getAccountInfo(client.protocol))) {
    const ix = await client.initProtocol({ admin: admin.publicKey, keeper: keeper.publicKey, payer: admin.publicKey, streamConfigs: [new PublicKey(state.configs["stream-25"]), new PublicKey(state.configs["stream-50"]), new PublicKey(state.configs["stream-75"])] });
    await send(connection, [ix], [admin], `init_protocol ${client.protocol.toBase58()}`);
  } else console.log(`protocol ${client.protocol.toBase58()} (exists)`);
  saveState(state);

  // 4. funding (only with the `fund` argument)
  if (process.argv.includes("fund")) {
    for (const [name, sol] of Object.entries(FUND)) {
      const pk = key(name).publicKey;
      const have = await connection.getBalance(pk);
      const want = Math.round(sol * LAMPORTS_PER_SOL);
      if (have >= want) { console.log(`${name} ${pk.toBase58()}: ${have / LAMPORTS_PER_SOL} SOL (ok)`); continue; }
      const adminLeft = await connection.getBalance(admin.publicKey);
      const amount = Math.min(want - have, Math.max(0, adminLeft - 0.5 * LAMPORTS_PER_SOL));
      if (amount <= 0) { console.log(`${name}: admin cannot spare more`); continue; }
      await send(connection, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: pk, lamports: amount })], [admin], `fund ${name} ${amount / LAMPORTS_PER_SOL} SOL`);
    }
  }
  for (const name of ["authority", "keeper", "depositor", "buyer"]) {
    const pk = key(name).publicKey;
    console.log(`${name} ${pk.toBase58()}: ${(await connection.getBalance(pk)) / LAMPORTS_PER_SOL} SOL`);
  }
  console.log(JSON.stringify(state, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
