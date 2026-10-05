"use client";
import { DesignedError, friendlyError, simulationReason } from "./errors";
import { failures } from "@/content/cometail";
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

/** The largest transaction the network accepts, in bytes (packet size). */
const MAX_TRANSACTION_BYTES = 1232;

/** A simulation failure that a node lagging behind the previous confirmation, or a busy node,
 *  produces; worth a short wait and another look before it is reported. */
function looksTransient(err: unknown, logs: string[]): boolean {
  const text = `${JSON.stringify(err)} ${logs.join(" ")}`.toLowerCase();
  return /accountnotinitialized|not initialized|wrongstatus|accountmismatch|could not find account|blockhashnotfound|minimum context slot|too many requests|429|node is behind|rate limit/.test(text);
}

/** Send a transaction with the connected wallet and wait for it. A transaction that lands with
 *  an error is a failure (the signature is kept for the explorer link); the confirmation waits on
 *  the blockhash the transaction was signed with, so expiry is reported, not hidden.
 *
 *  Wallet order, per Phantom's guidance on transaction warnings: the wallet is asked to sign
 *  alone and first. When the transaction needs other signers (a new mint, a vault placeholder),
 *  they add their signatures after the wallet, and the site sends the fully signed transaction
 *  through its own RPC. A transaction that is sent to the wallet already carrying other
 *  signatures is what triggers the "multi-signer" warning. Before the wallet sees anything the
 *  transaction is size-checked and simulated without signatures (sigVerify false), so a
 *  transaction that fails in that dry run stops here with plain copy instead of reaching the wallet
 *  (the dry run sees the chain at that moment; it is a filter, not a guarantee). */
export function useTx() {
  const { connection } = useConnection();
  const { sendTransaction, signTransaction, publicKey } = useWallet();
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
        // wire size = compact signature count (1 byte here) + 64 bytes per signer + the message;
        // measured on the message because serialize() itself refuses an oversized transaction
        let size: number;
        try {
          const signerCount = tx.compileMessage().header.numRequiredSignatures;
          size = 1 + 64 * signerCount + tx.serializeMessage().length;
        } catch (e) {
          // the message serializer writes into a packet-sized buffer and overruns it on a message
          // far above the limit ("encoding overruns" from the shim, "offset is out of range" from
          // node's Buffer); that overrun is the same answer as the size check, nothing else is
          const err = e as { name?: string; message?: string } | null;
          if (err?.name === "RangeError" && /overrun|out of range/i.test(err.message ?? "")) throw new DesignedError(failures.txTooLarge);
          throw e;
        }
        if (size > MAX_TRANSACTION_BYTES) throw new DesignedError(failures.txTooLarge);
        // dry run without any signature (web3.js sets sigVerify only when signers are passed); a
        // failure observed now stops before the wallet, mapped to the same plain copy as a live failure
        // The dry run runs right after the previous step's confirmation in a multi-step flow; a
        // load-balanced RPC node that has not seen that confirmation yet answers as if the earlier
        // step never happened (an account "not initialized", a status "wrong"), and a busy node
        // answers 429. Those are retried a few times with a pause before they count as a failure.
        let dry = await connection.simulateTransaction(tx);
        for (let attempt = 1; attempt <= 3 && dry.value.err && looksTransient(dry.value.err, dry.value.logs ?? []); attempt++) {
          await new Promise((r) => setTimeout(r, 1500 * attempt));
          dry = await connection.simulateTransaction(tx);
        }
        if (dry.value.err) {
          // a mapped failure gets its plain copy; anything else gets the generic line plus the
          // plainest reason the simulation offered, so the user sees why, not only that it failed
          const logs = dry.value.logs ?? [];
          const detail = [JSON.stringify(dry.value.err), ...logs].join(" | ");
          const mapped = friendlyError(new Error(detail), failures.simulationFailed);
          const reason = mapped === failures.simulationFailed ? simulationReason(dry.value.err, logs) : "";
          throw new DesignedError(reason ? `${mapped} ${failures.simulationReason} ${reason}` : mapped);
        }
        if (signers.length > 0) {
          if (!signTransaction) throw new DesignedError(failures.walletCannotSign);
          const signed = await signTransaction(tx);
          signed.partialSign(...signers);
          signature = await connection.sendRawTransaction(signed.serialize(), {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });
        } else {
          signature = await sendTransaction(tx, connection, { skipPreflight: false });
        }
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
          message: friendlyError(e, failures.txFailed),
        });
        return null;
      }
    },
    [connection, sendTransaction, signTransaction, publicKey],
  );
  return { run, status, connected: !!publicKey, publicKey };
}

export interface StorageReadiness { checked: boolean; ready: boolean; storage: string; imaging: boolean }
/** Whether token identities can be saved on this deployment: the site's own /api/metadata GET.
 *  Anything but a JSON "ready" answer counts as not ready, so the page says so before the form. */
export function useStorageReady(): StorageReadiness {
  const [state, setState] = useState<StorageReadiness>({ checked: false, ready: false, storage: "unknown", imaging: false });
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch("/api/metadata", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
        const j = await r.json();
        if (live) setState({ checked: true, ready: !!j.ready, storage: String(j.storage ?? "unknown"), imaging: !!j.imaging });
      } catch {
        if (live) setState({ checked: true, ready: false, storage: "unknown", imaging: false });
      }
    })();
    return () => { live = false; };
  }, []);
  return state;
}
