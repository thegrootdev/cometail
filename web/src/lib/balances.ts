"use client";
// Wallet balances read from the chain: SOL in lamports and a token in base units. They keep the
// last value while a refresh is in flight, refresh while the page is visible, and reload on demand
// (after every trade).
import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

function useChainValue<T>(fn: () => Promise<T | null>, deps: unknown[], everyMs: number) {
  const [value, setValue] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    // a new key starts from unknown: a previous owner's or mint's balance is never shown under
    // the new one; responses are sequenced so a slow older read cannot overwrite a newer one
    setValue(null);
    let seq = 0;
    const load = async () => {
      const mine = ++seq;
      setLoading(true);
      try {
        const next = await fn();
        if (live && mine === seq) setValue(next);
      } catch {
        // the last value for this key stands; the next refresh tries again
      } finally {
        if (live && mine === seq) setLoading(false);
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

/** The balance a trade can spend: the owner's associated token account for the mint under the
 *  mint's own token program (Token or Token-2022). The swap builders spend that account only, so
 *  tokens held elsewhere are not counted; a missing account is zero. */
export async function readTokenBalance(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<bigint> {
  const mintInfo = await connection.getAccountInfo(mint, "confirmed");
  if (!mintInfo) return 0n;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, mintInfo.owner);
  const info = await connection.getAccountInfo(ata, "confirmed");
  if (!info) return 0n;
  // SPL token account layout: amount is the u64 at offset 64 in both programs
  return info.data.length >= 72 ? info.data.readBigUInt64LE(64) : 0n;
}
export function useTokenBalance(mint: PublicKey | null | undefined, owner: PublicKey | null | undefined) {
  const { connection } = useConnection();
  const key = `${mint?.toBase58() ?? ""}:${owner?.toBase58() ?? ""}`;
  const r = useChainValue<bigint>(async () => (mint && owner ? readTokenBalance(connection, mint, owner) : null), [key], 30_000);
  return { raw: mint && owner ? r.value : null, loading: r.loading, reload: r.reload };
}
