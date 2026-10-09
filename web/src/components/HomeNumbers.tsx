"use client";
// Three live figures under the home promise, from the same proof document as /stats; each opens /stats,
// where it links to its source. Until that document answers, the burn line stands alone, as before. When a later
// read fails, the last figures stay but are marked last known, with the time they were read, until a read succeeds.
import { useEffect, useState } from "react";
import Link from "next/link";
import { BurnStat } from "./BurnPanel";
import { api, type Stats } from "@/lib/api";
import { useSolUsd } from "@/lib/prices";
import { usdValue } from "@/lib/usd";
import { home as copy } from "@/content/cometail";

export function HomeNumbers() {
  const [s, setS] = useState<Stats | null>(null);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => void api.stats().then((r) => { if (!live) return; if (r) { setS(r); setFresh(true); } else setFresh(false); });
    load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const rate = useSolUsd();
  if (!s) return <BurnStat />;
  // short figures for the chips: USD while the SOL reference is fresh, SOL otherwise; /stats has the exact values
  const short = (lamports: string | null) => {
    if (lamports === null) return "—";
    const sol = Number(lamports) / 1e9, usd = usdValue(sol, rate);
    return usd !== null ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(usd)
      : `${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(sol)} SOL`;
  };
  const burned = s.burn ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(Number(s.burn.burnedRaw) / 10 ** (s.burn.decimals ?? 6)) : null;
  return (
    <div className={`home-numbers ${fresh ? "" : "is-last-known"}`} aria-label={fresh ? copy.numbers.label : copy.numbers.lastKnown} title={fresh ? undefined : `${copy.numbers.lastKnown} (${new Date(s.generatedAtMs).toUTCString()})`}>
      <Link href="/stats" className="home-number"><strong>{short(s.trading.volumeLamports)}</strong><span>{copy.numbers.traded}</span></Link>
      <Link href="/stats" className="home-number"><strong>{short(s.fees.totalLamports)}</strong><span>{copy.numbers.fees}</span></Link>
      <Link href="/stats" className="home-number home-number-burn"><strong>{burned ?? "—"}</strong><span>{copy.numbers.burned}</span></Link>
      {!fresh && <span className="home-numbers-stale micro">{copy.numbers.stale} · {new Date(s.generatedAtMs).toLocaleTimeString("en-US", { timeStyle: "short", timeZone: "UTC" })} UTC</span>}
    </div>
  );
}
