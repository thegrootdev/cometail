// Mainnet dry run: builds the four DBC configs and init_protocol exactly as the mainnet setup
// would, with the owner's wallet as admin, fee claimer, leftover receiver and payer, and
// simulates every transaction against mainnet without signatures (sigVerify off). Nothing is
// sent; no key is read. Prints the simulation result and the compute of each instruction.
//   cd tests && ADMIN=<owner mainnet wallet> KEEPER=<box keeper pubkey> RPC=<mainnet rpc> \
//     ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 600000 mainnet/dryrun.ts
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { VaultClientStep6, VAULT_PROGRAM_ID } from "@cometail/client";
import { dbcProgram } from "../harness/programs";
import { configParams } from "../harness/dbc";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const ADMIN = new PublicKey(process.env.ADMIN ?? "");
const KEEPER = new PublicKey(process.env.KEEPER ?? ADMIN);

async function simulate(connection: Connection, label: string, ixs: any[], extraSigners: PublicKey[] = []) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = ADMIN;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const res = await connection.simulateTransaction(tx, undefined, false);
  const err = res.value.err;
  const logs = (res.value.logs ?? []).filter((l) => /Program log|failed|Error|error/.test(l)).slice(-6);
  console.log(`${label}: ${err ? "FAILED " + JSON.stringify(err) : "ok"} units=${res.value.unitsConsumed ?? "?"} signers=${[ADMIN, ...extraSigners].map((k) => k.toBase58().slice(0, 6)).join(",")}`);
  for (const l of logs) console.log("   ", l.slice(0, 160));
  return !err;
}

async function main() {
  if (!process.env.ADMIN) throw new Error("ADMIN (the owner's mainnet wallet public key) is required");
  const connection = new Connection(RPC, "confirmed");
  const cluster = await connection.getGenesisHash();
  console.log("rpc genesis", cluster, cluster === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" ? "(mainnet)" : "(NOT mainnet)");
  console.log("admin", ADMIN.toBase58(), "balance", (await connection.getBalance(ADMIN)) / 1e9, "SOL");
  const program = await connection.getAccountInfo(VAULT_PROGRAM_ID);
  console.log("program", VAULT_PROGRAM_ID.toBase58(), program?.executable ? "deployed" : "NOT deployed (init_protocol simulation will fail until docs/deploy.md step 2)");

  // 1. treasury: the admin's WSOL ATA
  // the real admin is an ordinary wallet; an off-curve placeholder is tolerated so the script can be
  // validated against a funded PDA without any key
  const treasury = getAssociatedTokenAddressSync(NATIVE_MINT, ADMIN, true);
  const treasuryExists = !!(await connection.getAccountInfo(treasury));
  console.log("treasury", treasury.toBase58(), treasuryExists ? "exists" : "to create");
  if (!treasuryExists) await simulate(connection, "treasury ata", [createAssociatedTokenAccountIdempotentInstruction(ADMIN, treasury, ADMIN, NATIVE_MINT)]);

  // 2. the four configs: new keypairs stand in for the config accounts; the real run generates fresh ones
  const configs: Record<string, PublicKey> = {};
  let ok = true;
  for (const name of ["stream-25", "stream-50", "stream-75", "plain"] as const) {
    const config = Keypair.generate();
    const params = configParams(name);
    const ix = await dbcProgram.methods.createConfig(params).accountsPartial({
      config: config.publicKey, feeClaimer: ADMIN, leftoverReceiver: ADMIN, quoteMint: NATIVE_MINT, payer: ADMIN, systemProgram: SystemProgram.programId,
    }).instruction();
    ok = (await simulate(connection, `create_config ${name}`, [ix], [config.publicKey])) && ok;
    configs[name] = config.publicKey;
    console.log(`    ${name}: migration threshold ${params.migrationQuoteThreshold?.toString?.() ?? "?"} lamports, creation fee ${params.poolCreationFee?.toString?.() ?? params.poolCreationFee ?? "?"}, migration fee ${JSON.stringify(params.migrationFee ?? {})}`);
  }

  // 3. init_protocol with the simulated config keys (the real run uses the created ones)
  const client = new VaultClientStep6(connection);
  const ix = await client.initProtocol({ admin: ADMIN, keeper: KEEPER, payer: ADMIN, treasury, streamConfigs: [configs["stream-25"], configs["stream-50"], configs["stream-75"]] });
  ok = (await simulate(connection, `init_protocol ${client.protocol.toBase58()}`, [ix])) && ok;
  console.log(ok ? "DRY RUN: every simulation passed" : "DRY RUN: at least one simulation failed (see above)");
}

describe("mainnet dry run", () => { it("simulates the config set and the protocol init without sending anything", main); });
