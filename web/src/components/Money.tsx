"use client";
import { market as copy, money } from "@/content/cometail";
import { useSolUsd } from "@/lib/prices";
import { formatUsd, usdValue } from "@/lib/usd";
import { marketNumber, marketTime, rawUnits } from "@/lib/market";
import { quoteAsset, WSOL, type QuoteAsset } from "@/lib/quotes";
import type { SolUsdRate } from "@/lib/usd";
import { CLUSTER } from "@/lib/addresses";

export function Money({ lamports, sol, price = false, secondary = true, quote, quoteRate }: {
  lamports?: string | bigint | null; sol?: string | number | null; price?: boolean; secondary?: boolean; quote?: QuoteAsset; quoteRate?: SolUsdRate;
}) {
  const solRate = useSolUsd();
  const asset = quote ?? quoteAsset(WSOL);
  const rate = quoteRate ?? (asset.mint === WSOL ? solRate : { value: null, source: null, at: null, status: "missing" as const });
  const amount = lamports !== undefined ? asset.decimals === null ? null : rawUnits(lamports === null ? null : String(lamports), asset.decimals) : sol;
  const usd = usdValue(amount, rate);
  const quoteNumber = amount === null || amount === undefined ? "—" : marketNumber(amount, price ? 9 : 5);
  const quoteText = amount === null || amount === undefined ? "—" : `${quoteNumber} ${asset.symbol}`;
  // Without a USD rate the quote amount takes the headline slot and its unit the small line, so a
  // long price never wraps inside the number; the rate's status reads small as well.
  return <span className="money-pair" data-price-status={rate.status}>
    <span className={usd === null ? "money-quote" : "money-usd"}>
      {usd === null ? quoteNumber : formatUsd(usd, price)}
    </span>
    {secondary && <small className="money-sol">{usd !== null ? quoteText : amount === null || amount === undefined ? (rate.status === "stale" ? money.stale : money.missing) : `${asset.symbol} · ${rate.status === "stale" ? money.stale : money.missing}`}</small>}
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
