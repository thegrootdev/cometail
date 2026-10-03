// Mainnet setup, run by the protocol owner: the treasury WSOL account, the nine DBC configs
// (three stream presets, the plain preset, and the five public presets) and init_protocol, in
// that order, resumable (each step is skipped once its account exists in configs/mainnet.json and
// on chain). DRY_RUN=1 simulates every transaction without signatures and sends nothing; the
// init simulation needs the real stream configs, so before they exist it is reported SKIPPED,
// never PASS. The cluster must be mainnet (genesis checked). Every failure exits non-zero.
//
//   cd tests && RPC=<keyed mainnet rpc> ADMIN=<owner wallet> KEEPER=<keeper pubkey> \
//     COMETAIL_QUOTE_USDC=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v COMETAIL_QUOTE_STOCK=<stock mint> \
//     DRY_RUN=1 ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 1200000 mainnet/setup.ts
//   The real run adds ADMIN_KEYPAIR=<path to the owner's keypair file, mode 600, outside the repo>
//   and drops DRY_RUN. State: configs/mainnet.json (public addresses only).
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { BorshAccountsCoder, Idl } from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
import { VaultClientStep6, VAULT_PROGRAM_ID } from "@cometail/client";
import { dbcProgram } from "../harness/programs";
import { configParams, PresetName } from "../harness/dbc";

const ROOT = path.resolve(__dirname, "..", "..");
const STATE = path.join(ROOT, "configs", "mainnet.json");
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DBC_PROGRAM = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
const DRY = process.env.DRY_RUN === "1";
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };

const PROTOCOL_SET: PresetName[] = ["stream-25", "stream-50", "stream-75", "plain"];
const PUBLIC_SET: PresetName[] = ["long", "flat", "exp", "stock-usdc", "stock-xstock"];

type Outcome = { step: string; status: "PASS" | "FAIL" | "SKIPPED" | "DONE" | "EXISTS"; detail: string };
const outcomes: Outcome[] = [];
const note = (o: Outcome) => { outcomes.push(o); console.log(`${o.status.padEnd(7)} ${o.step}: ${o.detail}`); };

function load(): any { return fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { cluster: "mainnet-beta", configs: {}, presets: {}, quoteMints: {} }; }
function save(s: any) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n"); }
const exists = async (c: Connection, k: string | undefined) => !!k && !!(await c.getAccountInfo(new PublicKey(k)));

async function run(connection: Connection, label: string, ixs: TransactionInstruction[], payer: PublicKey, signers: Keypair[]): Promise<boolean> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer;
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  if (DRY) {
    const res = await connection.simulateTransaction(tx, undefined, false);
    if (res.value.err) { note({ step: label, status: "FAIL", detail: `${JSON.stringify(res.value.err)} ${(res.value.logs ?? []).filter((l) => /Error|failed/.test(l)).slice(-2).join(" | ")}` }); return false; }
    note({ step: label, status: "PASS", detail: `simulated, ${res.value.unitsConsumed ?? "?"} CU` });
    return true;
  }
  const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
  note({ step: label, status: "DONE", detail: sig });
  return true;
}

/** The DBC token badge for a Token-2022 quote that is not permissionless; remaining account 0 on create_config. */
function badgeOf(quoteMint: PublicKey): PublicKey { return PublicKey.findProgramAddressSync([Buffer.from("token_badge"), quoteMint.toBuffer()], DBC_PROGRAM)[0]; }

async function main() {
  const connection = new Connection(need("RPC"), "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS) throw new Error(`RPC is not mainnet (genesis ${genesis})`);
  const admin = new PublicKey(need("ADMIN"));
  const keeper = new PublicKey(need("KEEPER"));
  if (keeper.equals(admin)) throw new Error("KEEPER must be the keeper hot key, not the admin");
  const usdc = new PublicKey(need("COMETAIL_QUOTE_USDC"));
  const stock = new PublicKey(need("COMETAIL_QUOTE_STOCK"));
  let adminKeypair: Keypair | null = null;
  if (!DRY) {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(need("ADMIN_KEYPAIR"), "utf8"))));
    if (!kp.publicKey.equals(admin)) throw new Error("ADMIN_KEYPAIR does not match ADMIN");
    adminKeypair = kp;
  }
  const state = load();
  state.cluster = "mainnet-beta"; state.programId = VAULT_PROGRAM_ID.toBase58(); state.admin = admin.toBase58(); state.keeper = keeper.toBase58();
  state.quoteMints = { wsol: NATIVE_MINT.toBase58(), usdc: usdc.toBase58(), stock: stock.toBase58() };
  save(state);
  console.log(`mode ${DRY ? "DRY RUN (simulation only, nothing sent)" : "REAL"}; admin ${admin.toBase58()}; keeper ${keeper.toBase58()}; balance ${(await connection.getBalance(admin)) / 1e9} SOL`);
  const program = await connection.getAccountInfo(VAULT_PROGRAM_ID);
  note({ step: "program deployed", status: program?.executable ? "PASS" : "SKIPPED", detail: program?.executable ? VAULT_PROGRAM_ID.toBase58() : "not on mainnet yet: init_protocol waits for docs/deploy.md" });

  // the quote mints: USDC must be a plain SPL mint; the stock must be Token-2022 with a DBC badge
  const usdcInfo = await connection.getAccountInfo(usdc), stockInfo = await connection.getAccountInfo(stock);
  note({ step: "usdc quote mint", status: usdcInfo && usdcInfo.data.length >= 45 ? "PASS" : "FAIL", detail: usdcInfo ? `decimals ${usdcInfo.data[44]}, program ${usdcInfo.owner.toBase58().slice(0, 8)}` : "absent" });
  const stockIs2022 = !!stockInfo && stockInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
  const badge = badgeOf(stock);
  const badgeInfo = await connection.getAccountInfo(badge);
  note({ step: "stock quote mint", status: stockInfo ? "PASS" : "FAIL", detail: stockInfo ? `decimals ${stockInfo.data[44]}, ${stockIs2022 ? "Token-2022" : "SPL"}` : "absent" });
  note({ step: "stock token badge", status: badgeInfo || !stockIs2022 ? "PASS" : "FAIL", detail: badgeInfo ? badge.toBase58() : stockIs2022 ? "no DBC token badge: a Meteora operator must create one first" : "not needed for an SPL quote" });
  let ok = usdcInfo !== null && stockInfo !== null && (badgeInfo !== null || !stockIs2022);

  // 1. treasury
  const treasury = getAssociatedTokenAddressSync(NATIVE_MINT, admin);
  state.treasury = treasury.toBase58(); save(state);
  if (await exists(connection, state.treasury)) note({ step: "treasury ata", status: "EXISTS", detail: state.treasury });
  else ok = (await run(connection, "treasury ata", [createAssociatedTokenAccountIdempotentInstruction(admin, treasury, admin, NATIVE_MINT)], admin, adminKeypair ? [adminKeypair] : [])) && ok;

  // 2. the nine configs
  const quoteOf = (name: PresetName): PublicKey => name === "stock-usdc" ? usdc : name === "stock-xstock" ? stock : NATIVE_MINT;
  for (const name of [...PROTOCOL_SET, ...PUBLIC_SET]) {
    const bucket = PROTOCOL_SET.includes(name) ? state.configs : state.presets;
    if (await exists(connection, bucket[name])) { note({ step: `config ${name}`, status: "EXISTS", detail: bucket[name] }); continue; }
    process.env.COMETAIL_QUOTE_USDC = usdc.toBase58(); process.env.COMETAIL_QUOTE_STOCK = stock.toBase58();
    const config = Keypair.generate();
    const quote = quoteOf(name);
    let builder = dbcProgram.methods.createConfig(configParams(name)).accountsPartial({
      config: config.publicKey, feeClaimer: admin, leftoverReceiver: admin, quoteMint: quote, payer: admin, systemProgram: SystemProgram.programId,
    });
    if (name === "stock-xstock" && stockIs2022) builder = builder.remainingAccounts([{ pubkey: badge, isSigner: false, isWritable: false }]);
    const done = await run(connection, `config ${name} (${quote.equals(NATIVE_MINT) ? "WSOL" : quote.toBase58().slice(0, 8)})`, [await builder.instruction()], admin, adminKeypair ? [adminKeypair, config] : []);
    ok = done && ok;
    if (done && !DRY) { bucket[name] = config.publicKey.toBase58(); save(state); }
  }

  // 3. init_protocol: only with the real stream configs and the treasury on chain
  const client = new VaultClientStep6(connection);
  state.protocol = client.protocol.toBase58(); save(state);
  const streams = ["stream-25", "stream-50", "stream-75"].map((n) => state.configs[n]);
  if (await exists(connection, state.protocol)) note({ step: "init_protocol", status: "EXISTS", detail: state.protocol });
  else if (!program?.executable) note({ step: "init_protocol", status: "SKIPPED", detail: "program not deployed" });
  else if (!streams.every(Boolean) || !(await exists(connection, state.treasury))) note({ step: "init_protocol", status: "SKIPPED", detail: "needs the three stream configs and the treasury on chain first (rerun after the real config step)" });
  else {
    const ix = await client.initProtocol({ admin, keeper, payer: admin, treasury, streamConfigs: streams.map((k: string) => new PublicKey(k)) as [PublicKey, PublicKey, PublicKey] });
    ok = (await run(connection, "init_protocol", [ix], admin, adminKeypair ? [adminKeypair] : [])) && ok;
  }

  // 4. readback of what exists: quote mint and threshold of every recorded config
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "idls", "dynamic_bonding_curve.json"), "utf8")) as Idl;
  const coder = new BorshAccountsCoder(idl);
  const accountName = (idl.accounts ?? []).find((a) => /^poolconfig$/i.test(a.name))?.name ?? "PoolConfig";
  for (const [name, key] of [...Object.entries(state.configs), ...Object.entries(state.presets)] as [string, string][]) {
    const info = await connection.getAccountInfo(new PublicKey(key));
    if (!info) continue;
    const c: any = coder.decode(accountName, info.data);
    const q = new PublicKey(c.quote_mint ?? c.quoteMint).toBase58();
    note({ step: `readback ${name}`, status: q === quoteOf(name as PresetName).toBase58() ? "PASS" : "FAIL", detail: `quote ${q.slice(0, 8)} threshold ${(c.migration_quote_threshold ?? c.migrationQuoteThreshold).toString()}` });
    if (q !== quoteOf(name as PresetName).toBase58()) ok = false;
  }
  console.log(JSON.stringify({ mode: DRY ? "dry-run" : "real", outcomes }, null, 2));
  if (!ok) throw new Error("at least one step failed; see the outcomes above");
}

describe("mainnet setup", () => { it(DRY ? "simulates every step and sends nothing" : "creates what is missing", main); });
