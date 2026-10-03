"use client";
// Wallet balances read from the chain: SOL in lamports and a token in base units. They keep the
// last value while a refresh is in flight, refresh while the page is visible, and reload on demand
// (after every trade).
import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { Connection, PublicKey } from "@solana/web3.js";

function useChainValue<T>(fn: () => Promise<T | null>, deps: unknown[], everyMs: number) {
  const [value, setValue] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const load = async () => {
      setLoading(true);
      try {
        const next = await fn();
        if (live) setValue(next);
      } catch {
        // the last value stands; the next refresh tries again
      } finally {
        if (live) setLoading(false);
      }
    };
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = setInterval(refresh, everyMs);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { value, loading, reload: () => setTick((t) => t + 1) };
}

export function useSolBalance(owner: PublicKey | null | undefined) {
  const { connection } = useConnection();
  const key = owner?.toBase58() ?? null;
  const r = useChainValue<bigint>(async () => (owner ? BigInt(await connection.getBalance(owner, "confirmed")) : null), [key], 30_000);
  return { lamports: key ? r.value : null, loading: r.loading, reload: r.reload };
}

/** All token accounts of the owner for the mint, summed (Token and Token-2022 alike). */
export async function readTokenBalance(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<bigint> {
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed");
  let total = 0n;
  for (const a of accounts.value) total += BigInt(String(a.account.data.parsed?.info?.tokenAmount?.amount ?? "0"));
  return total;
}
export function useTokenBalance(mint: PublicKey | null | undefined, owner: PublicKey | null | undefined) {
  const { connection } = useConnection();
  const key = `${mint?.toBase58() ?? ""}:${owner?.toBase58() ?? ""}`;
  const r = useChainValue<bigint>(async () => (mint && owner ? readTokenBalance(connection, mint, owner) : null), [key], 30_000);
  return { raw: mint && owner ? r.value : null, loading: r.loading, reload: r.reload };
}
