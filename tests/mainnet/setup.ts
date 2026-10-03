// Mainnet setup, run by the protocol owner: the treasury WSOL account, the nine DBC configs
// (three stream presets, the plain preset, and the five public presets) and init_protocol, in
// that order, resumable. Order of a run: the cluster (genesis), the inputs against the recorded
// deployment (configs/mainnet.json never gets rewritten with different authorities or quotes),
// the preflight (program, both quote mints, the stock badge, the wallet's balance against the
// rent and fees of the work still pending, nothing when everything exists): any failed check
// stops the run before anything is simulated, sent or saved. A recorded account is skipped only
// after it decodes and matches every parameter. DRY_RUN=1 simulates every transaction with the
// admin's public key, sends nothing and writes nothing; the init simulation needs the real stream
// configs, so before they exist it is reported SKIPPED, never PASS. The real run requires the
// deployed program, records each address as its transaction confirms, and stops before any later
// send once one has failed (the record keeps what confirmed; rerun to resume). Any FAIL exits
// non-zero.
//
//   cd tests && RPC=<keyed mainnet rpc> ADMIN=<owner wallet> KEEPER=<keeper pubkey> \
//     COMETAIL_QUOTE_USDC=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v COMETAIL_QUOTE_STOCK=Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh \
//     DRY_RUN=1 ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 1200000 mainnet/setup.ts
//   The real run adds ADMIN_KEYPAIR=<path to the owner's keypair file, mode 600, outside the repo>
//   and drops DRY_RUN. State: configs/mainnet.json (public addresses only).
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { BorshAccountsCoder, Idl } from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
import { VaultClientStep6, VAULT_PROGRAM_ID } from "@cometail/client";
import { dbcProgram } from "../harness/programs";
import { configParams, PresetName } from "../harness/dbc";
import { CONFIG_NAMES, DBC_PROGRAM, GENESIS, PROTOCOL_SET, Check, badgeOf, compareConfig, compareProtocol, readBadge, readMint } from "./readback";

const ROOT = path.resolve(__dirname, "..", "..");
const STATE = path.join(ROOT, "configs", "mainnet.json");
const CANONICAL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// Account sizes of what this script creates (measured on devnet 2026-10-03), rent is quoted from the RPC.
const CONFIG_BYTES = 1048, PROTOCOL_BYTES = 202, ATA_BYTES = 165, TX_FEE_LAMPORTS = 5_000, MARGIN_LAMPORTS = 20_000_000;
const DRY = process.env.DRY_RUN === "1";
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };

type Outcome = { step: string; status: "PASS" | "FAIL" | "SKIPPED" | "DONE" | "EXISTS"; detail: string };
const outcomes: Outcome[] = [];
const note = (o: Outcome) => { outcomes.push(o); console.log(`${o.status.padEnd(7)} ${o.step}: ${o.detail}`); };
const failed = () => outcomes.filter((o) => o.status === "FAIL");
/** The real run never sends again after a failed send; the record keeps what confirmed. */
const halted = () => !DRY && failed().length > 0;
const fileDecimals = (name: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "configs", `${name}.json`), "utf8")).token.tokenQuoteDecimal as number;

const dbcIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "idls", "dynamic_bonding_curve.json"), "utf8")) as Idl;
const vaultIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "packages", "client", "idl", "cometail_vault.json"), "utf8")) as Idl;
const dbcCoder = new BorshAccountsCoder(dbcIdl), vaultCoder = new BorshAccountsCoder(vaultIdl);
const POOL_CONFIG = (dbcIdl.accounts ?? []).find((a) => /^poolconfig$/i.test(a.name))?.name ?? "PoolConfig";
const PROTOCOL = (vaultIdl.accounts ?? []).find((a) => /^protocol$/i.test(a.name))?.name ?? "Protocol";

async function run(connection: Connection, label: string, ixs: TransactionInstruction[], payer: PublicKey, signers: Keypair[]): Promise<boolean> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  if (DRY) {
    const res = await connection.simulateTransaction(tx, undefined, false);
    if (res.value.err) { note({ step: label, status: "FAIL", detail: `${JSON.stringify(res.value.err)} ${(res.value.logs ?? []).filter((l) => /Error|failed/.test(l)).slice(-2).join(" | ")}` }); return false; }
    note({ step: label, status: "PASS", detail: `simulated, ${res.value.unitsConsumed ?? "?"} CU` });
    return true;
  }
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
    note({ step: label, status: "DONE", detail: sig });
    return true;
  } catch (e: any) { note({ step: label, status: "FAIL", detail: String(e?.message ?? e).slice(0, 200) }); return false; }
}

/** A recorded config is skipped only when the account exists, belongs to DBC and matches every parameter. */
async function recordedConfigMatches(connection: Connection, name: PresetName, key: string, quote: PublicKey, quoteIs2022: boolean, admin: PublicKey): Promise<string[]> {
  const info = await connection.getAccountInfo(new PublicKey(key));
  if (!info) return [`recorded config ${name} ${key} does not exist on chain`];
  if (!info.owner.equals(DBC_PROGRAM)) return [`recorded config ${name} is owned by ${info.owner.toBase58()}, not DBC`];
  const checks = compareConfig(dbcCoder.decode(POOL_CONFIG, info.data), configParams(name), { quoteMint: quote.toBase58(), quoteIs2022, admin: admin.toBase58() });
  return checks.filter((c) => !c.ok).map((c) => `recorded config ${name}: ${c.what} ${c.detail}`);
}

async function main() {
  const connection = new Connection(need("RPC"), "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis !== GENESIS["mainnet-beta"]) throw new Error(`RPC is not mainnet (genesis ${genesis})`);
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

  // the recorded deployment, never rewritten with different authorities or quotes
  const recorded = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : null;
  const header = { cluster: "mainnet-beta", programId: VAULT_PROGRAM_ID.toBase58(), admin: admin.toBase58(), keeper: keeper.toBase58(), quoteMints: { wsol: NATIVE_MINT.toBase58(), usdc: usdc.toBase58(), stock: stock.toBase58() } };
  if (recorded) {
    const diffs: string[] = [];
    for (const f of ["cluster", "programId", "admin", "keeper"] as const) if (recorded[f] !== undefined && recorded[f] !== header[f]) diffs.push(`${f}: recorded ${recorded[f]}, run ${header[f]}`);
    for (const f of ["wsol", "usdc", "stock"] as const) if (recorded.quoteMints?.[f] !== undefined && recorded.quoteMints[f] !== header.quoteMints[f]) diffs.push(`quoteMints.${f}: recorded ${recorded.quoteMints[f]}, run ${header.quoteMints[f]}`);
    if (diffs.length) throw new Error(`configs/mainnet.json records a different deployment; refusing to rewrite it:\n${diffs.join("\n")}`);
  }
  const state: any = { ...header, configs: {}, presets: {}, ...(recorded ?? {}), ...header };
  const save = () => { if (!DRY) fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n"); };
  const balance = await connection.getBalance(admin);
  console.log(`mode ${DRY ? "DRY RUN (simulation only, nothing sent, nothing written)" : "REAL"}; admin ${admin.toBase58()}; keeper ${keeper.toBase58()}; balance ${balance / 1e9} SOL`);

  // preflight: everything below must pass before any simulation, send or save
  const program = await connection.getAccountInfo(VAULT_PROGRAM_ID);
  const deployed = !!program?.executable;
  note({ step: "program deployed", status: deployed ? "PASS" : DRY ? "SKIPPED" : "FAIL", detail: deployed ? VAULT_PROGRAM_ID.toBase58() : DRY ? "not on mainnet yet: init_protocol is skipped in this dry run" : "not on mainnet: deploy first (docs/deploy.md)" });
  const usdcMint = await readMint(connection, usdc);
  const usdcOk = usdcMint.ok && !usdcMint.is2022 && usdcMint.decimals === fileDecimals("stock-usdc") && usdc.toBase58() === CANONICAL_USDC;
  note({ step: "usdc quote mint", status: usdcOk ? "PASS" : "FAIL", detail: usdcOk ? usdcMint.detail : `${usdcMint.detail}; must be ${CANONICAL_USDC} (SPL, ${fileDecimals("stock-usdc")} decimals)` });
  const stockMint = await readMint(connection, stock);
  const stockOk = stockMint.ok && stockMint.decimals === fileDecimals("stock-xstock");
  note({ step: "stock quote mint", status: stockOk ? "PASS" : "FAIL", detail: stockOk ? stockMint.detail : `${stockMint.detail}; the file expects ${fileDecimals("stock-xstock")} decimals` });
  const stockIs2022 = stockMint.ok && stockMint.is2022;
  const badge = badgeOf(stock);
  if (stockIs2022) { const b = await readBadge(connection, stock); note({ step: "stock token badge", status: b.ok ? "PASS" : "FAIL", detail: b.ok ? b.detail : `${b.detail}: a Meteora operator must create the badge first` }); }
  else note({ step: "stock token badge", status: "PASS", detail: "not needed for an SPL quote" });
  // the budget: rent and fees of the work still pending (nothing when everything is recorded)
  const treasury = getAssociatedTokenAddressSync(NATIVE_MINT, admin);
  const client = new VaultClientStep6(connection);
  const rent = async (bytes: number) => await connection.getMinimumBalanceForRentExemption(bytes);
  const pendingConfigs = CONFIG_NAMES.filter((n) => !(PROTOCOL_SET.includes(n) ? state.configs : state.presets)[n]).length;
  const pendingTreasury = !(await connection.getAccountInfo(treasury)), pendingProtocol = !(await connection.getAccountInfo(client.protocol));
  const needed = pendingConfigs * (await rent(CONFIG_BYTES) + TX_FEE_LAMPORTS) + (pendingTreasury ? await rent(ATA_BYTES) + TX_FEE_LAMPORTS : 0) + (pendingProtocol ? await rent(PROTOCOL_BYTES) + TX_FEE_LAMPORTS : 0);
  const required = needed > 0 ? needed + MARGIN_LAMPORTS : 0;
  note({ step: "admin balance", status: balance >= required ? "PASS" : "FAIL", detail: `${balance / 1e9} SOL; pending ${pendingConfigs} config(s)${pendingTreasury ? ", treasury" : ""}${pendingProtocol ? ", protocol" : ""} need ${required / 1e9} SOL (rent, fees, ${MARGIN_LAMPORTS / 1e9} margin)${balance >= required ? "" : "; a simulation with an unfunded payer fails too"}` });
  if (failed().length) throw new Error(`preflight failed, nothing simulated, sent or saved:\n${failed().map((o) => `${o.step}: ${o.detail}`).join("\n")}`);

  // recorded accounts: validated before they are skipped
  const quoteOf = (name: PresetName): PublicKey => name === "stock-usdc" ? usdc : name === "stock-xstock" ? stock : NATIVE_MINT;
  process.env.COMETAIL_QUOTE_USDC = usdc.toBase58(); process.env.COMETAIL_QUOTE_STOCK = stock.toBase58();
  const mismatches: string[] = [];
  for (const name of CONFIG_NAMES) {
    const bucket = PROTOCOL_SET.includes(name) ? state.configs : state.presets;
    if (bucket[name]) mismatches.push(...(await recordedConfigMatches(connection, name, bucket[name], quoteOf(name), name === "stock-xstock" && stockIs2022, admin)));
  }
  const protocolInfo = await connection.getAccountInfo(client.protocol);
  if (protocolInfo) {
    const checks: Check[] = compareProtocol(protocolInfo.owner, vaultCoder.decode(PROTOCOL, protocolInfo.data), { admin: admin.toBase58(), keeper: keeper.toBase58(), treasury: treasury.toBase58(), configs: state.configs }, VAULT_PROGRAM_ID, false);
    mismatches.push(...checks.filter((c) => !c.ok).map((c) => `protocol: ${c.what} ${c.detail}`));
  }
  if (mismatches.length) throw new Error(`recorded state does not match the chain or the inputs; nothing simulated, sent or saved:\n${mismatches.join("\n")}`);
  state.treasury = treasury.toBase58(); state.protocol = client.protocol.toBase58();
  save();

  // 1. treasury
  if (await connection.getAccountInfo(treasury)) note({ step: "treasury ata", status: "EXISTS", detail: state.treasury });
  else await run(connection, "treasury ata", [createAssociatedTokenAccountIdempotentInstruction(admin, treasury, admin, NATIVE_MINT)], admin, adminKeypair ? [adminKeypair] : []);

  // 2. the nine configs
  for (const name of CONFIG_NAMES) {
    const bucket = PROTOCOL_SET.includes(name) ? state.configs : state.presets;
    if (bucket[name]) { note({ step: `config ${name}`, status: "EXISTS", detail: `${bucket[name]} (matches every parameter)` }); continue; }
    if (halted()) { note({ step: `config ${name}`, status: "SKIPPED", detail: "a send failed above; nothing else is sent (rerun to resume)" }); continue; }
    const config = Keypair.generate();
    const quote = quoteOf(name);
    let builder = dbcProgram.methods.createConfig(configParams(name)).accountsPartial({
      config: config.publicKey, feeClaimer: admin, leftoverReceiver: admin, quoteMint: quote, payer: admin, systemProgram: SystemProgram.programId,
    });
    if (name === "stock-xstock" && stockIs2022) builder = builder.remainingAccounts([{ pubkey: badge, isSigner: false, isWritable: false }]);
    const done = await run(connection, `config ${name} (${quote.equals(NATIVE_MINT) ? "WSOL" : quote.toBase58().slice(0, 8)})`, [await builder.instruction()], admin, adminKeypair ? [adminKeypair, config] : []);
    if (done && !DRY) { bucket[name] = config.publicKey.toBase58(); save(); }
  }

  // 3. init_protocol: only with the real stream configs and the treasury on chain
  const streams = ["stream-25", "stream-50", "stream-75"].map((n) => state.configs[n]);
  const prerequisites = deployed && streams.every(Boolean) && !!(await connection.getAccountInfo(treasury));
  if (protocolInfo) note({ step: "init_protocol", status: "EXISTS", detail: `${state.protocol} (admin, keeper, treasury and pins match)` });
  else if (halted()) note({ step: "init_protocol", status: "SKIPPED", detail: "a send failed above; nothing else is sent (rerun to resume)" });
  else if (!prerequisites) note({ step: "init_protocol", status: DRY ? "SKIPPED" : "FAIL", detail: `needs the deployed program, the three stream configs and the treasury on chain${DRY ? " (expected in a dry run before step 5)" : ": setup is incomplete, fix the failures above and rerun"}` });
  else {
    const ix = await client.initProtocol({ admin, keeper, payer: admin, treasury, streamConfigs: streams.map((k: string) => new PublicKey(k)) as [PublicKey, PublicKey, PublicKey] });
    await run(connection, "init_protocol", [ix], admin, adminKeypair ? [adminKeypair] : []);
  }

  // 4. readback of every recorded config and the protocol, field by field
  for (const name of CONFIG_NAMES) {
    const bucket = PROTOCOL_SET.includes(name) ? state.configs : state.presets;
    if (!bucket[name]) continue;
    const bad = await recordedConfigMatches(connection, name, bucket[name], quoteOf(name), name === "stock-xstock" && stockIs2022, admin);
    note({ step: `readback ${name}`, status: bad.length ? "FAIL" : "PASS", detail: bad.length ? bad.join("; ").slice(0, 300) : "every parameter matches the file" });
  }
  if (!DRY && !protocolInfo) {
    const after = await connection.getAccountInfo(client.protocol);
    if (after) { const checks = compareProtocol(after.owner, vaultCoder.decode(PROTOCOL, after.data), { admin: admin.toBase58(), keeper: keeper.toBase58(), treasury: treasury.toBase58(), configs: state.configs }, VAULT_PROGRAM_ID, false); note({ step: "readback protocol", status: checks.every((c) => c.ok) ? "PASS" : "FAIL", detail: checks.filter((c) => !c.ok).map((c) => `${c.what} ${c.detail}`).join("; ") || "admin, keeper, treasury and pins match" }); }
  }
  console.log(JSON.stringify({ mode: DRY ? "dry-run" : "real", plan: DRY ? state : undefined, outcomes }, null, 2));
  if (failed().length) throw new Error(`${failed().length} step(s) failed; see the outcomes above`);
}

describe("mainnet setup", () => { it(DRY ? "simulates every step and sends nothing" : "creates what is missing", main); });
