"use client";
import { market as copy, money } from "@/content/cometail";
import { useSolUsd } from "@/lib/prices";
import { formatUsd, usdValue } from "@/lib/usd";
import { marketNumber, marketTime, rawUnits } from "@/lib/market";
import { CLUSTER } from "@/lib/addresses";

export function Money({ lamports, sol, price = false, secondary = true }: {
  lamports?: string | bigint | null; sol?: string | number | null; price?: boolean; secondary?: boolean;
}) {
  const rate = useSolUsd();
  const amount = lamports !== undefined ? rawUnits(lamports === null ? null : String(lamports), 9) : sol;
  const usd = usdValue(amount, rate);
  return <span className="money-pair" data-price-status={rate.status}>
    <span className={usd === null ? "money-unavailable" : "money-usd"}>
      {rate.status === "fresh" ? formatUsd(usd, price) : rate.status === "stale" ? money.stale : money.missing}
    </span>
    {secondary && amount !== null && amount !== undefined && <small className="money-sol">{marketNumber(amount, price ? 9 : 5)} SOL</small>}
  </span>;
}
export function PriceReference() {
  const rate = useSolUsd();
  return <span className="price-reference" data-price-status={rate.status}>
    {CLUSTER !== "mainnet-beta" && <span className="market-network">{copy.reference}</span>}
    <span>{rate.status === "fresh" ? <>{money.rate} {formatUsd(rate.value)} · {rate.source} · {marketTime(rate.at)}</>
      : rate.status === "stale" ? copy.fxStale : copy.fxMissing}</span>
  </span>;
}
