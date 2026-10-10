import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { FailedTransactionMetadata, LiteSVM, TransactionMetadata } from "litesvm";
import fs from "fs";
import { utils } from "@coral-xyz/anchor";
import path from "path";

export type SendResult = { logs: string[]; computeUnits: bigint; bytes: number };
export const measurements: { label: string; bytes: number; computeUnits: string }[] = [];

/** Send a legacy transaction; throws with the full log on failure. */
export function send(svm: LiteSVM, ixs: TransactionInstruction[], signers: Keypair[], opts: { cu?: number; label?: string } = {}): SendResult {
  const tx = new Transaction();
  if (opts.cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cu }));
  tx.add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(...signers);
  const bytes = tx.serialize().length;
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  if (res instanceof FailedTransactionMetadata) {
    throw new Error(`${opts.label ?? "tx"} failed: ${res.err()}\n${res.meta().logs().join("\n")}`);
  }
  const meta = res as TransactionMetadata;
  const out = { logs: meta.logs(), computeUnits: meta.computeUnitsConsumed(), bytes };
  if (opts.label) measurements.push({ label: opts.label, bytes, computeUnits: out.computeUnits.toString() });
  return out;
}

/** Expect a failure whose logs contain `needle`. */
/** Send like `send`, and return the executed transaction the way the worker reads one from an RPC (IndexedTx): the
 *  compiled message (header, keys, instructions), every inner instruction from the receipt, and the classic token
 *  accounts' balances before the transaction (preTokenBalances). */
export function sendIndexed(svm: LiteSVM, ixs: TransactionInstruction[], signers: Keypair[], opts: { cu?: number; label?: string } = {}) {
  const tx = new Transaction();
  if (opts.cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cu }));
  tx.add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  const message = tx.compileMessage();
  const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const preTokenBalances = message.accountKeys.flatMap((k, accountIndex) => {
    const a = svm.getAccount(k);
    if (!a || !new PublicKey(a.owner).equals(TOKEN) || a.data.length !== 165) return [];
    const d = Buffer.from(a.data);
    return [{ accountIndex, mint: new PublicKey(d.subarray(0, 32)).toBase58(), uiTokenAmount: { amount: d.readBigUInt64LE(64).toString() } }];
  });
  tx.sign(...signers);
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  if (res instanceof FailedTransactionMetadata) throw new Error(`${opts.label ?? "tx"} failed: ${res.err()}\n${res.meta().logs().join("\n")}`);
  const meta = res as TransactionMetadata;
  if (opts.label) measurements.push({ label: opts.label, bytes: tx.serialize().length, computeUnits: meta.computeUnitsConsumed().toString() });
  const innerInstructions = meta.innerInstructions().map((group: any[], index: number) => ({
    index,
    instructions: group.map((inner: any) => { const ix = inner.instruction(); return { programIdIndex: ix.programIdIndex(), accounts: Array.from(ix.accounts() as Uint8Array), data: utils.bytes.bs58.encode(Buffer.from(ix.data())) }; }),
  }));
  return { slot: 1, blockTime: 1, meta: { err: null, innerInstructions, preTokenBalances }, transaction: { message } } as any;
}

export function expectFail(svm: LiteSVM, ixs: TransactionInstruction[], signers: Keypair[], needle: string, opts: { cu?: number } = {}) {
  try {
    send(svm, ixs, signers, opts);
  } catch (e: any) {
    if (!String(e.message).includes(needle)) throw new Error(`expected failure containing "${needle}", got: ${String(e.message).slice(0, 600)}`);
    return;
  }
  throw new Error(`expected failure containing "${needle}" but the transaction succeeded`);
}

// ---- test-only forwarder: a program-derived signer for Meteora paths ----
const FWD_DIR = path.resolve(__dirname, "..", "programs", "test_forwarder", "target", "deploy");
// read when first used, so a gate that never forwards (and CI, which has no forwarder build) can import this file
let forwarderId: PublicKey | null = null;
export function FORWARDER(): PublicKey {
  if (!forwarderId) forwarderId = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(FWD_DIR, "test_forwarder-keypair.json"), "utf8")))).publicKey;
  return forwarderId;
}
export function loadForwarder(svm: LiteSVM) {
  svm.addProgramFromFile(FORWARDER(), path.join(FWD_DIR, "test_forwarder.so"));
}
export function pdaSigner(seed: string): { key: PublicKey; bump: number; seed: Buffer } {
  const s = Buffer.from(seed);
  const [key, bump] = PublicKey.findProgramAddressSync([Buffer.from("vault"), s], FORWARDER());
  return { key, bump, seed: s };
}
/** Wrap `ix` so the forwarder re-invokes it with `signer.key` signing. */
export function forward(ix: TransactionInstruction, signer: { key: PublicKey; bump: number; seed: Buffer }): TransactionInstruction {
  const keys = [
    { pubkey: ix.programId, isSigner: false, isWritable: false },
    ...ix.keys.map((k) => ({ pubkey: k.pubkey, isWritable: k.isWritable, isSigner: k.pubkey.equals(signer.key) ? false : k.isSigner })),
  ];
  const data = Buffer.concat([Buffer.from([signer.bump, signer.seed.length]), signer.seed, Buffer.from(ix.data)]);
  return new TransactionInstruction({ programId: FORWARDER(), keys, data });
}
