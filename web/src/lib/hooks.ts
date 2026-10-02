"use client";
import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, Transaction } from "@solana/web3.js";

/** Load something async; `deps` re-run it. */
export function useLoad<T>(fn: () => Promise<T | null>, deps: unknown[]): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fn().then((d) => { if (live) { setData(d); setError(null); } }).catch((e) => { if (live) setError(String(e?.message ?? e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, loading, error, reload: () => setTick((t) => t + 1) };
}

/** Send a transaction with the connected wallet; keeps the last status for the page. */
export function useTx() {
  const { connection } = useConnection();
  const { sendTransaction, publicKey } = useWallet();
  const [status, setStatus] = useState<{ state: "idle" | "sending" | "done" | "error"; signature?: string; message?: string }>({ state: "idle" });
  const run = useCallback(async (build: () => Promise<Transaction>, signers: Keypair[] = []) => {
    if (!publicKey) { setStatus({ state: "error", message: "Connect a wallet first." }); return null; }
    setStatus({ state: "sending" });
    try {
      const tx = await build();
      tx.feePayer = tx.feePayer ?? publicKey;
      const signature = await sendTransaction(tx, connection, { signers, skipPreflight: false });
      const latest = await connection.getLatestBlockhash("confirmed");
      await connection.confirmTransaction({ signature, ...latest }, "confirmed");
      setStatus({ state: "done", signature });
      return signature;
    } catch (e: any) {
      setStatus({ state: "error", message: String(e?.message ?? e).slice(0, 300) });
      return null;
    }
  }, [connection, sendTransaction, publicKey]);
  return { run, status, connected: !!publicKey, publicKey };
}
