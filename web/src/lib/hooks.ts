"use client";
import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ComputeBudgetProgram, Keypair, Transaction } from "@solana/web3.js";

/** Load something async; `deps` re-run it; `everyMs` keeps it fresh while the page is open. */
export function useLoad<T>(
  fn: () => Promise<T | null>,
  deps: unknown[],
  everyMs = 0,
): {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    let busy = false;
    setData(null);
    setError(null);
    setLoading(true);
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const value = await fn();
        if (live) {
          setData(value);
          setError(null);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      } finally {
        busy = false;
        if (live) setLoading(false);
      }
    };
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = everyMs > 0 ? setInterval(refresh, everyMs) : null;
    if (everyMs > 0) document.addEventListener("visibilitychange", refresh);
    return () => {
      live = false;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, loading, error, reload: () => setTick((t) => t + 1) };
}

export type TxStatus = {
  state: "idle" | "sending" | "done" | "error";
  signature?: string;
  message?: string;
};

/** Send a transaction with the connected wallet and wait for it. A transaction that lands with
 *  an error is a failure (the signature is kept for the explorer link); the confirmation waits on
 *  the blockhash the transaction was signed with, so expiry is reported, not hidden. */
export function useTx() {
  const { connection } = useConnection();
  const { sendTransaction, publicKey } = useWallet();
  const [status, setStatus] = useState<TxStatus>({ state: "idle" });
  const run = useCallback(
    async (
      build: () => Promise<Transaction>,
      signers: Keypair[] = [],
      computeUnits = 400_000,
    ): Promise<string | null> => {
      if (!publicKey) {
        setStatus({ state: "error", message: "Connect a wallet first." });
        return null;
      }
      setStatus({ state: "sending" });
      let signature: string | undefined;
      try {
        const built = await build();
        const tx = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
          ...built.instructions,
        );
        tx.feePayer = built.feePayer ?? publicKey;
        const latest = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = latest.blockhash;
        tx.lastValidBlockHeight = latest.lastValidBlockHeight;
        signature = await sendTransaction(tx, connection, {
          signers,
          skipPreflight: false,
        });
        const result = await connection.confirmTransaction(
          {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          "confirmed",
        );
        if (result.value.err)
          throw new Error(
            `transaction failed on chain: ${JSON.stringify(result.value.err)}`,
          );
        setStatus({ state: "done", signature });
        return signature;
      } catch (e: any) {
        setStatus({
          state: "error",
          signature,
          message: String(e?.message ?? e).slice(0, 300),
        });
        return null;
      }
    },
    [connection, sendTransaction, publicKey],
  );
  return { run, status, connected: !!publicKey, publicKey };
}
