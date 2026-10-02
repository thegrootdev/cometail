// Transaction helpers: every write is simulated first, then sent with a compute budget and
// confirmed; an expired blockhash is retried once. A simulation failure is a normal outcome
// (policy says no, nothing to claim) and is logged, not thrown. Wide instructions go out as
// v0 transactions with a lookup table.
import { EventParser } from "@coral-xyz/anchor";
import {
  AddressLookupTableAccount, ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { alert } from "./alert";

export interface SendResult { ok: boolean; signature?: string; logs: string[]; error?: string; events: { name: string; data: any }[] }

export function log(msg: string, extra?: Record<string, unknown>) {
  const line = { ts: new Date().toISOString(), msg, ...(extra ?? {}) };
  console.log(JSON.stringify(line, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof PublicKey ? v.toBase58() : v)));
}

export function parseEvents(parser: EventParser, logs: string[]): { name: string; data: any }[] {
  const out: { name: string; data: any }[] = [];
  try { for (const ev of parser.parseLogs(logs)) out.push({ name: ev.name, data: ev.data }); } catch { /* foreign logs */ }
  return out;
}

export interface SendArgs {
  connection: Connection; payer: Keypair; ixs: TransactionInstruction[]; signers?: Keypair[]; cu?: number; cuPrice?: number;
  parser?: EventParser; dryRun?: boolean; label: string; lookupTable?: AddressLookupTableAccount | null;
}

function budgetIxs(a: SendArgs): TransactionInstruction[] {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: a.cu ?? 400_000 })];
  if (a.cuPrice && a.cuPrice > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: a.cuPrice }));
  return ixs;
}

async function build(a: SendArgs, blockhash: string): Promise<{ raw: Buffer | Uint8Array; sim: () => Promise<any> }> {
  const signers = [a.payer, ...(a.signers ?? [])];
  if (a.lookupTable) {
    const msg = new TransactionMessage({ payerKey: a.payer.publicKey, recentBlockhash: blockhash, instructions: [...budgetIxs(a), ...a.ixs] }).compileToV0Message([a.lookupTable]);
    const tx = new VersionedTransaction(msg);
    tx.sign(signers);
    return { raw: tx.serialize(), sim: () => a.connection.simulateTransaction(tx, { sigVerify: true }) };
  }
  const tx = new Transaction();
  tx.add(...budgetIxs(a), ...a.ixs);
  tx.feePayer = a.payer.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  return { raw: tx.serialize(), sim: () => a.connection.simulateTransaction(tx) };
}

export async function sendTx(a: SendArgs): Promise<SendResult> {
  let last: SendResult = { ok: false, logs: [], events: [], error: "not sent" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { blockhash, lastValidBlockHeight } = await a.connection.getLatestBlockhash("confirmed");
    const { raw, sim: simulate } = await build(a, blockhash);
    const sim = await simulate();
    const logs: string[] = sim.value.logs ?? [];
    const events = a.parser ? parseEvents(a.parser, logs) : [];
    if (sim.value.err) {
      const error = JSON.stringify(sim.value.err);
      log(`${a.label}: simulation rejected`, { error, tail: logs.slice(-4) });
      return { ok: false, logs, error, events };
    }
    if (a.dryRun) { log(`${a.label}: dry run, would send`, { cu: sim.value.unitsConsumed }); return { ok: true, logs, events }; }
    try {
      const signature = await a.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
      const conf = await a.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (conf.value.err) {
        const error = JSON.stringify(conf.value.err);
        log(`${a.label}: failed on chain`, { signature, error });
        await alert("error", `${a.label} failed on chain`, { signature, error });
        return { ok: false, signature, logs, error, events };
      }
      log(`${a.label}: confirmed`, { signature, cu: sim.value.unitsConsumed });
      return { ok: true, signature, logs, events };
    } catch (e) {
      const error = String((e as Error).message ?? e);
      last = { ok: false, logs, error, events };
      const expired = /block height exceeded|expired|Blockhash not found/i.test(error);
      log(`${a.label}: send failed${expired && attempt === 0 ? ", retrying with a fresh blockhash" : ""}`, { error });
      if (!expired) break;
    }
  }
  await alert("error", `${a.label} not sent`, { error: last.error });
  return last;
}

/** Simulate only; returns the decoded program events (used to size harvests before paying for them). */
export async function simulateEvents(a: { connection: Connection; payer: PublicKey; ixs: TransactionInstruction[]; parser: EventParser; cu?: number }): Promise<{ ok: boolean; events: { name: string; data: any }[]; error?: string }> {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: a.cu ?? 400_000 }), ...a.ixs);
  tx.feePayer = a.payer;
  tx.recentBlockhash = (await a.connection.getLatestBlockhash("confirmed")).blockhash;
  const sim = await a.connection.simulateTransaction(tx);
  const events = parseEvents(a.parser, sim.value.logs ?? []);
  return sim.value.err ? { ok: false, events, error: JSON.stringify(sim.value.err) } : { ok: true, events };
}
