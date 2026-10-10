// Mainnet: the "Paired with $COMETAIL" launch preset (configs/paired.json): a DBC config whose quote is $COMETAIL,
// with the launch treasury (manifest `treasuryOwner`) as fee claimer and leftover receiver, like the other launch
// presets. The quote and its pool are the ones the burn program pinned at its setup (read from its state), and both
// are checked first: $COMETAIL under the classic token program, 6 decimals, no mint or freeze authority; its pool
// $COMETAIL/SOL on DAMM v2. Resumable; any FAIL exits non-zero.
//   cd tests && RPC=<keyed mainnet rpc> PAYER=<box payer pubkey> DRY_RUN=1 ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 1200000 mainnet/paired-config.ts
//   The real run adds PAYER_KEYPAIR=<its file> and drops DRY_RUN; it never runs without the owner's go.
// State: configs/mainnet.json under presets.paired and quoteMints.cometail (public addresses only).
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, unpackMint } from "@solana/spl-token";
import { BorshAccountsCoder, Idl } from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
import { BurnClient } from "@cometail/client";
import { dammProgram, dbcProgram } from "../harness/programs";
import { configParams } from "../harness/dbc";
import { DBC_PROGRAM, GENESIS, compareConfig } from "./readback";

const ROOT = path.resolve(__dirname, "..", "..");
const STATE = path.join(ROOT, "configs", "mainnet.json");
const DRY = process.env.DRY_RUN === "1";
const DAMM_V2 = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };
const dbcIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "idls", "dynamic_bonding_curve.json"), "utf8")) as Idl;
const coder = new BorshAccountsCoder(dbcIdl);
const POOL_CONFIG = (dbcIdl.accounts ?? []).find((a) => /^poolconfig$/i.test(a.name))?.name ?? "PoolConfig";
const results: { step: string; status: string; detail: string }[] = [];
const note = (step: string, status: string, detail: string) => { results.push({ step, status, detail }); console.log(`${status.padEnd(7)} ${step}: ${detail}`); };

async function main() {
  const connection = new Connection(need("RPC"), "confirmed");
  const cluster = process.env.CLUSTER ?? "mainnet-beta";
  if ((await connection.getGenesisHash()) !== GENESIS[cluster]) throw new Error(`RPC is not ${cluster}`);
  const statePath = process.env.STATE_FILE ?? STATE;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.presets ??= {}; state.quoteMints ??= {};
  const payer = new PublicKey(need("PAYER"));
  const payerKeypair = DRY ? null : Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(need("PAYER_KEYPAIR"), "utf8"))));
  if (payerKeypair && !payerKeypair.publicKey.equals(payer)) throw new Error("PAYER_KEYPAIR is not PAYER");
  const treasury = new PublicKey(state.treasuryOwner ?? need("TREASURY"));

  // the quote and its pool: the burn program's own, read from its state
  const client = new BurnClient(connection);
  const stInfo = await connection.getAccountInfo(client.a.burnState, "confirmed");
  if (!stInfo) { note("burn state", "FAIL", `${client.a.burnState.toBase58()} not found: the burn program is not set up on this cluster`); throw new Error("preflight failed"); }
  const burn = client.decodeState(stInfo.data);
  const mint = burn.cometailMint, pool = burn.pool;
  if (process.env.COMETAIL_QUOTE_COMETAIL && process.env.COMETAIL_QUOTE_COMETAIL !== mint.toBase58()) note("quote mint", "FAIL", `COMETAIL_QUOTE_COMETAIL ${process.env.COMETAIL_QUOTE_COMETAIL} is not the burn program's $COMETAIL ${mint.toBase58()}`);
  const mintInfo = await connection.getAccountInfo(mint, "confirmed");
  const m = mintInfo && mintInfo.owner.equals(TOKEN_PROGRAM_ID) ? unpackMint(mint, mintInfo, TOKEN_PROGRAM_ID) : null;
  const mintOk = !!m && m.decimals === 6 && m.mintAuthority === null && m.freezeAuthority === null;
  note("quote mint", mintOk ? "PASS" : "FAIL", m ? `${mint.toBase58()}: classic token program, ${m.decimals} decimals, mint authority ${m.mintAuthority?.toBase58() ?? "none"}, freeze authority ${m.freezeAuthority?.toBase58() ?? "none"}, supply ${m.supply}` : `${mint.toBase58()} is not a classic SPL mint`);
  const poolInfo = await connection.getAccountInfo(pool, "confirmed");
  const p: any = poolInfo && poolInfo.owner.equals(DAMM_V2) ? dammProgram.coder.accounts.decode("pool", poolInfo.data) : null;
  const poolOk = !!p && p.tokenAMint.equals(mint) && p.tokenBMint.equals(NATIVE_MINT);
  note("$COMETAIL pool", poolOk ? "PASS" : "FAIL", p ? `${pool.toBase58()}: token A ${p.tokenAMint.toBase58()}, token B ${p.tokenBMint.toBase58()}, collect fee mode ${p.collectFeeMode}` : `${pool.toBase58()} is not a DAMM v2 pool`);
  note("fee claimer", "PASS", `${treasury.toBase58()} (the launch treasury, as for the other launch presets), also the leftover receiver`);

  const params = configParams("paired");
  const expect = { quoteMint: mint.toBase58(), quoteIs2022: false, feeClaimer: treasury.toBase58(), leftoverReceiver: treasury.toBase58() };
  const recorded = state.presets.paired as string | undefined;
  const size = 1048;
  const rent = await connection.getMinimumBalanceForRentExemption(size);
  const balance = await connection.getBalance(payer);
  const needLamports = recorded ? 0 : rent + 10_000;
  note("payer balance", balance >= needLamports ? "PASS" : "FAIL", `${balance / 1e9} SOL at ${payer.toBase58()}; the config needs ${needLamports / 1e9} SOL (rent ${rent / 1e9} SOL for ${size} bytes, plus two signatures)`);
  if (results.some((r) => r.status === "FAIL")) throw new Error("preflight failed; nothing simulated, sent or saved");

  if (recorded) {
    const info = await connection.getAccountInfo(new PublicKey(recorded));
    const problems = !info ? ["does not exist"] : !info.owner.equals(DBC_PROGRAM) ? ["not a DBC account"] : compareConfig(coder.decode(POOL_CONFIG, info.data), params, expect).filter((c) => !c.ok).map((c) => `${c.what} ${c.detail}`);
    note("paired config", problems.length ? "FAIL" : "EXISTS", problems.length ? problems.join("; ") : `${recorded} matches configs/paired.json`);
    if (problems.length) throw new Error("recorded paired config does not match; stopping");
    return;
  }
  const config = Keypair.generate();
  const ix = await dbcProgram.methods.createConfig(params).accountsPartial({
    config: config.publicKey, feeClaimer: treasury, leftoverReceiver: treasury, quoteMint: mint, payer, systemProgram: SystemProgram.programId,
  }).instruction();
  const tx = new Transaction().add(ix as TransactionInstruction);
  tx.feePayer = payer; tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  if (DRY) {
    const res = await connection.simulateTransaction(tx, undefined, [config.publicKey]);
    const acct = res.value.accounts?.[0];
    const data = acct ? Buffer.from(acct.data[0], "base64") : null;
    const problems = res.value.err ? [JSON.stringify(res.value.err)] : !data ? ["the simulation returned no account"] : compareConfig(coder.decode(POOL_CONFIG, data), params, expect).filter((c) => !c.ok).map((c) => `${c.what} ${c.detail}`);
    if (data && data.length !== size) problems.push(`account is ${data.length} bytes, not ${size}`);
    note("paired config", problems.length ? "FAIL" : "PASS", problems.length ? problems.join("; ") : `simulated, ${res.value.unitsConsumed ?? "?"} CU; ${data!.length} bytes, rent ${(acct!.lamports / 1e9).toFixed(9)} SOL; every parameter matches configs/paired.json; threshold ${coder.decode(POOL_CONFIG, data!).migration_quote_threshold?.toString() ?? "?"} raw $COMETAIL`);
    if (problems.length) throw new Error("FAIL above");
    return;
  }
  const sig = await sendAndConfirmTransaction(connection, tx, [payerKeypair!, config], { commitment: "confirmed" });
  const info = (await connection.getAccountInfo(config.publicKey))!;
  const problems = compareConfig(coder.decode(POOL_CONFIG, info.data), params, expect).filter((c) => !c.ok).map((c) => `${c.what} ${c.detail}`);
  note("paired config", problems.length ? "FAIL" : "DONE", problems.length ? `${config.publicKey.toBase58()}: ${problems.join("; ")}` : `${config.publicKey.toBase58()} ${sig}; rent ${info.lamports / 1e9} SOL`);
  state.presets.paired = config.publicKey.toBase58();
  state.quoteMints.cometail = mint.toBase58();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  if (problems.length) throw new Error("readback failed; stopping");
}

describe("mainnet paired config", () => { it("creates or checks the $COMETAIL-paired preset", main); });
