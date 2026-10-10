// A read-only Connection over LiteSVM, enough for the site's builders (Meteora's SDKs read accounts, the slot and
// the clock through it), so a gate can build transactions with the very code the site runs and send them here.
import { AccountInfo, Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { FailedTransactionMetadata } from "litesvm";
import { LiteSVM } from "litesvm";

function info(svm: LiteSVM, key: PublicKey): AccountInfo<Buffer> | null {
  const a = svm.getAccount(key);
  if (!a || (a.lamports === 0 && a.data.length === 0)) return null;
  return { data: Buffer.from(a.data), executable: a.executable, lamports: Number(a.lamports), owner: a.owner, rentEpoch: 0 };
}
export function svmConnection(svm: LiteSVM): Connection {
  const slot = () => Number(svm.getClock().slot);
  const ctx = <T>(value: T) => ({ context: { slot: slot() }, value });
  const keyOf = (k: PublicKey | string) => (typeof k === "string" ? new PublicKey(k) : k);
  const c: any = {
    rpcEndpoint: "litesvm", commitment: "confirmed",
    getAccountInfo: async (k: PublicKey) => info(svm, keyOf(k)),
    getAccountInfoAndContext: async (k: PublicKey) => ctx(info(svm, keyOf(k))),
    getMultipleAccountsInfo: async (ks: PublicKey[]) => ks.map((k) => info(svm, keyOf(k))),
    getMultipleAccountsInfoAndContext: async (ks: PublicKey[]) => ctx(ks.map((k) => info(svm, keyOf(k)))),
    getSlot: async () => slot(),
    getBlockTime: async () => Number(svm.getClock().unixTimestamp),
    getBalance: async (k: PublicKey) => Number(svm.getBalance(keyOf(k)) ?? 0),
    getLatestBlockhash: async () => ({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: slot() + 150 }),
    getMinimumBalanceForRentExemption: async (n: number) => Number(svm.minimumBalanceForRentExemption(BigInt(n))),
    // a wallet-less simulation, as the site runs one (no signatures checked), returning the requested accounts after it
    simulateTransaction: async (tx: Transaction, _signers?: unknown, include?: PublicKey[]) => {
      tx.recentBlockhash = svm.latestBlockhash();
      const v = new VersionedTransaction(tx.compileMessage());
      svm.withSigverify(false);
      const r = svm.simulateTransaction(v);
      svm.withSigverify(true);
      if (r instanceof FailedTransactionMetadata) return ctx({ err: String(r.err()), logs: r.meta().logs(), accounts: null, unitsConsumed: 0 });
      const post = r.postAccounts();
      const field = (a: any, f: string) => (typeof a[f] === "function" ? a[f]() : a[f]);
      const accounts = (include ?? []).map((k) => {
        const hit = post.find(([a]) => new PublicKey(a).equals(k));
        if (!hit) return null;
        return { data: [Buffer.from(field(hit[1], "data")).toString("base64"), "base64"], lamports: Number(field(hit[1], "lamports")), owner: new PublicKey(field(hit[1], "owner")).toBase58(), executable: false };
      });
      return ctx({ err: null, logs: r.meta().logs(), accounts, unitsConsumed: Number(r.meta().computeUnitsConsumed()) });
    },
  };
  return new Proxy(c, { get: (t, p) => (p in t ? t[p] : () => { throw new Error(`svmConnection: ${String(p)} is not provided`); }) }) as Connection;
}
