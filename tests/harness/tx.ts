import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { FailedTransactionMetadata, LiteSVM, TransactionMetadata } from "litesvm";
import fs from "fs";
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
