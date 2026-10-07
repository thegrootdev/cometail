// Mainnet: the four SOL launch presets again (Standard, Long, Flat, Exponential), identical to today's in
// every parameter and in the leftover receiver; only the fee claimer differs: the burn program's claimer PDA,
// so the program claims their protocol fees and splits them 50/50 (burn reserve, treasury). The two
// non-SOL presets stay as they are: the burn reserve only spends SOL. Resumable; any FAIL exits non-zero.
// Order of a run: the cluster (genesis), the burn program deployed (so its claimer is meaningful), today's
// recorded presets read back, the payer's balance; then per preset: a recorded new config must exist, belong
// to DBC, match every parameter and differ from today's account ONLY in the fee claimer bytes, or the run
// stops; a missing one is simulated (DRY_RUN=1) or created and then read back the same way.
//   cd tests && RPC=<keyed mainnet rpc> PAYER=<box payer pubkey> DRY_RUN=1 ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 1200000 mainnet/burn-configs.ts
//   The real run adds PAYER_KEYPAIR=<its file> and drops DRY_RUN; it never runs without the owner's go.
// State: configs/mainnet.json under "burnPresets" (public addresses only).
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { BorshAccountsCoder, Idl } from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
import { BurnClient, BURN_PROGRAM_ID } from "@cometail/client";
import { dbcProgram } from "../harness/programs";
import { configParams, PresetName } from "../harness/dbc";
import { DBC_PROGRAM, GENESIS, compareConfig } from "./readback";

const ROOT = path.resolve(__dirname, "..", "..");
const STATE = path.join(ROOT, "configs", "mainnet.json");
const DRY = process.env.DRY_RUN === "1";
const SET: PresetName[] = ["plain", "long", "flat", "exp"];
const CLAIMER_AT = 40; // PoolConfig.fee_claimer after the discriminator and quote_mint
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };
const dbcIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "idls", "dynamic_bonding_curve.json"), "utf8")) as Idl;
const coder = new BorshAccountsCoder(dbcIdl);
const POOL_CONFIG = (dbcIdl.accounts ?? []).find((a) => /^poolconfig$/i.test(a.name))?.name ?? "PoolConfig";
const results: { step: string; status: string; detail: string }[] = [];
const note = (step: string, status: string, detail: string) => { results.push({ step, status, detail }); console.log(`${status.padEnd(7)} ${step}: ${detail}`); };

/** Today's preset and the new one: every byte equal except the fee claimer, which is the burn claimer. */
function sameExceptClaimer(today: Buffer, fresh: Buffer, claimer: PublicKey): string[] {
  if (today.length !== fresh.length) return [`sizes differ (${today.length} vs ${fresh.length})`];
  const diff = [...today.keys()].filter((i) => today[i] !== fresh[i] && (i < CLAIMER_AT || i >= CLAIMER_AT + 32));
  const out = diff.length ? [`bytes differ outside the fee claimer at offsets ${diff.slice(0, 8).join(",")}${diff.length > 8 ? "…" : ""}`] : [];
  if (!new PublicKey(fresh.subarray(CLAIMER_AT, CLAIMER_AT + 32)).equals(claimer)) out.push("fee claimer is not the burn claimer");
  return out;
}

async function main() {
  const connection = new Connection(need("RPC"), "confirmed");
  if ((await connection.getGenesisHash()) !== GENESIS["mainnet-beta"]) throw new Error("RPC is not mainnet");
  const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
  state.burnPresets ??= {};
  const payer = new PublicKey(need("PAYER"));
  const payerKeypair = DRY ? null : Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(need("PAYER_KEYPAIR"), "utf8"))));
  if (payerKeypair && !payerKeypair.publicKey.equals(payer)) throw new Error("PAYER_KEYPAIR is not PAYER");
  const claimer = new BurnClient(connection).a.claimer;
  const program = await connection.getAccountInfo(BURN_PROGRAM_ID);
  note("burn program", program?.executable ? "PASS" : "FAIL", program?.executable ? `${BURN_PROGRAM_ID.toBase58()} deployed; claimer ${claimer.toBase58()}` : `${BURN_PROGRAM_ID.toBase58()} is not deployed: deploy it before its configs`);
  const todayOf = (n: PresetName): string | undefined => (n === "plain" ? state.configs?.plain : state.presets?.[n]);
  const today: Record<string, Buffer> = {};
  const leftover: Record<string, PublicKey> = {};
  for (const n of SET) {
    const k = todayOf(n);
    const info = k ? await connection.getAccountInfo(new PublicKey(k)) : null;
    if (!info || !info.owner.equals(DBC_PROGRAM)) { note(`today's ${n}`, "FAIL", `${k ?? "not recorded"} is not a DBC config on chain`); continue; }
    today[n] = info.data;
    leftover[n] = coder.decode(POOL_CONFIG, info.data).leftover_receiver ?? coder.decode(POOL_CONFIG, info.data).leftoverReceiver;
    note(`today's ${n}`, "PASS", `${k}; leftover receiver ${leftover[n].toBase58()} (kept)`);
  }
  const pending = SET.filter((n) => !state.burnPresets[n]).length;
  const rent = await connection.getMinimumBalanceForRentExemption(1048);
  const balance = await connection.getBalance(payer);
  const needLamports = pending * (rent + 10_000) + (pending ? 20_000_000 : 0);
  note("payer balance", balance >= needLamports ? "PASS" : "FAIL", `${balance / 1e9} SOL at ${payer.toBase58()}; ${pending} config(s) need ${needLamports / 1e9} SOL`);
  if (results.some((r) => r.status === "FAIL")) throw new Error("preflight failed; nothing simulated, sent or saved");

  for (const n of SET) {
    const recorded = state.burnPresets[n];
    if (recorded) {
      const info = await connection.getAccountInfo(new PublicKey(recorded));
      const problems = !info ? ["does not exist"] : !info.owner.equals(DBC_PROGRAM) ? ["not a DBC account"] : [
        ...sameExceptClaimer(today[n], info.data, claimer),
        ...compareConfig(coder.decode(POOL_CONFIG, info.data), configParams(n), { quoteMint: NATIVE_MINT.toBase58(), quoteIs2022: false, feeClaimer: claimer.toBase58(), leftoverReceiver: leftover[n].toBase58() }).filter((c) => !c.ok).map((c) => `${c.what} ${c.detail}`),
      ];
      note(`burn ${n}`, problems.length ? "FAIL" : "EXISTS", problems.length ? problems.join("; ") : `${recorded} (identical to today's except the fee claimer)`);
      if (problems.length) throw new Error(`recorded burn config ${n} does not match; stopping`);
      continue;
    }
    const config = Keypair.generate();
    const ix = await dbcProgram.methods.createConfig(configParams(n)).accountsPartial({
      config: config.publicKey, feeClaimer: claimer, leftoverReceiver: leftover[n], quoteMint: NATIVE_MINT, payer, systemProgram: SystemProgram.programId,
    }).instruction();
    const tx = new Transaction().add(ix as TransactionInstruction);
    tx.feePayer = payer; tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    if (DRY) {
      const res = await connection.simulateTransaction(tx, undefined, false);
      note(`burn ${n}`, res.value.err ? "FAIL" : "PASS", res.value.err ? JSON.stringify(res.value.err) : `simulated, ${res.value.unitsConsumed ?? "?"} CU; fee claimer ${claimer.toBase58()}, leftover ${leftover[n].toBase58()}`);
      continue;
    }
    const sig = await sendAndConfirmTransaction(connection, tx, [payerKeypair!, config], { commitment: "confirmed" });
    const info = (await connection.getAccountInfo(config.publicKey))!;
    const problems = sameExceptClaimer(today[n], info.data, claimer);
    note(`burn ${n}`, problems.length ? "FAIL" : "DONE", problems.length ? `${config.publicKey.toBase58()}: ${problems.join("; ")}` : `${config.publicKey.toBase58()} ${sig}`);
    state.burnPresets[n] = config.publicKey.toBase58();
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
    if (problems.length) throw new Error("readback failed; stopping");
  }
  if (results.some((r) => r.status === "FAIL")) throw new Error("FAIL above");
}

describe("mainnet burn configs", () => { it("creates or checks the four SOL presets with the burn claimer", main); });
