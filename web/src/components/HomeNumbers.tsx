"use client";
// Three live figures under the home promise, from the same proof document as /stats; each opens /stats,
// where it links to its source. Until that document answers, the burn line stands alone, as before. The figures show
// as live only while their own reads are recent (lib/freshness.ts): a kept document, or a later read that fails, keeps
// the last figures marked last known, with the time they were read, until a new read arrives.
import { useEffect, useState } from "react";
import Link from "next/link";
import { BurnStat } from "./BurnPanel";
import { api, type Stats } from "@/lib/api";
import { useSolUsd } from "@/lib/prices";
import { usdValue } from "@/lib/usd";
import { home as copy } from "@/content/cometail";
import { homeNumbersState, isLive, LIVE_FOR_MS, pollFigures } from "@/lib/freshness";

export function HomeNumbers() {
  const [s, setS] = useState<Stats | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    // a kept answer is asked again soon: the rebuild it started is usually done by then
    const stop = pollFigures(async () => {
      const r = await api.stats();
      if (!live) return false;
      if (r) setS(r);
      setFailed(!r);
      return !!r && !isLive(r.generatedAtMs, r.servedAtMs, LIVE_FOR_MS.stats);
    }, 60_000);
    return () => { live = false; stop(); };
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
  const f = homeNumbersState(s, failed);
  const burned = s.burn ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(Number(s.burn.burnedRaw) / 10 ** (s.burn.decimals ?? 6)) : null;
  return (
    <div className={`home-numbers ${f.docLive ? "" : "is-last-known"}`} aria-label={f.label} title={f.title}>
      <Link href="/stats" className="home-number"><strong>{short(s.trading.volumeLamports)}</strong><span>{copy.numbers.traded}</span></Link>
      <Link href="/stats" className="home-number"><strong>{short(s.fees.totalLamports)}</strong><span>{copy.numbers.fees}</span></Link>
      <Link href="/stats" className={`home-number home-number-burn ${f.burnLive ? "" : "is-last-known"}`}><strong>{burned ?? "—"}</strong><span>{copy.numbers.burned}</span></Link>
      {f.stale && <span className="home-numbers-stale micro">{f.stale}</span>}
    </div>
  );
}
