"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { API_URL } from "./addresses";
import { missingRate, parseRate, PRICE_MAX_AGE_MS, SolUsdRate } from "./usd";

const PriceContext = createContext<SolUsdRate>(missingRate);
/** One shared feed for the whole app, retained across page navigation. */
export function SolUsdProvider({ children }: { children: React.ReactNode }) {
  const [rate, setRate] = useState<SolUsdRate>(missingRate);
  useEffect(() => {
    let live = true, busy = false, lastAttempt = 0;
    let controller: AbortController | undefined;
    const refresh = async () => {
      setRate(old => old.status === "fresh" && old.at !== null && Date.now() - old.at >= PRICE_MAX_AGE_MS
        ? { ...old, status: "stale" } : old);
      if (!live || busy || document.visibilityState !== "visible" || Date.now() - lastAttempt < 60_000) return;
      busy = true; lastAttempt = Date.now(); controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 12_000);
      try {
        const response = await fetch(`${API_URL}/api/prices`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Price unavailable");
        const next = parseRate(await response.json());
        if (next.status === "missing") throw new Error("Invalid price");
        if (live) setRate(next);
      } catch {
        if (live) setRate(old => old.value === null ? missingRate : { ...old, status: "stale" });
      } finally { clearTimeout(timeout); busy = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    const visibility = () => void refresh();
    document.addEventListener("visibilitychange", visibility);
    return () => { live = false; controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  return <PriceContext.Provider value={rate}>{children}</PriceContext.Provider>;
}
export const useSolUsd = () => useContext(PriceContext);
