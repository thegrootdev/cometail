"use client";
// The token page's market panel (in Details) and its trades list; the home feed lives in CoinFeed.
import { useEffect, useRef, useState } from "react";
import { Money } from "./Money";
import { formatAmount } from "@/lib/amounts";
import { quoteAsset, quoteRate, type QuoteAsset } from "@/lib/quotes";
import type { SolUsdRate } from "@/lib/usd";
import { formatUsd, usdValue } from "@/lib/usd";
import { market as copy, money } from "@/content/cometail";
import { EXPLORER } from "@/lib/addresses";
import { ago, short } from "@/lib/format";
import { MarketEnvelope, MarketToken, TradeList, useMarket, rawUnits, marketNumber, marketTime } from "@/lib/market";
import { DataState } from "./Experience";

/** The API's definitions start lowercase; a footnote starts a sentence. */
const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
function Snapshot({ data, error = false, onRetry }: { data: MarketEnvelope<unknown> | null; error?: boolean; onRetry: () => void }) {
  const stale = error || data?.coverage.status === "stale";
  return <div className={`market-snapshot ${stale ? "market-stale" : ""}`} role="status">
    <span className="market-signal" aria-hidden="true" />
    <span>{stale ? copy.stale : data?.coverage.status === "partial" ? copy.partial : copy.current}
      {data && <> · {copy.snapshot} {marketTime(data.coverage.lastSuccessfulAtMs ?? data.generatedAtMs)}</>}</span>
    {stale && <button type="button" onClick={onRetry}>{copy.retry} ↻</button>}
  </div>;
}
function Metric({ label, value, note, exact }: { label: string; value: React.ReactNode; note?: string; exact?: string | null }) {
  return <div className="market-metric"><dt>{label}</dt><dd title={exact ?? undefined}>{value}{note && <small>{note}</small>}</dd></div>;
}
function TokenStats({ token, observedAt }: { token: MarketToken; observedAt: number }) {
  const rate = quoteRate(token.quoteUsd, observedAt);
  const asset = quoteAsset(token.quoteMint, token.quoteDecimals, null, token.quoteUsd?.sol);
  const supply = rawUnits(token.totalSupplyRaw, token.decimals);
  const price = token.priceStatus === "stale" || token.priceStatus === "unavailable" ? null : token.priceQuote;
  const fdvSol = supply !== null && price !== null ? Number(supply) * Number(price) : null;
  const fdv = usdValue(fdvSol, rate);
  const holders = token.holders?.status === "unavailable" ? null : token.holders?.count;
  return <dl className="market-stats">
    <Metric label={copy.price} value={<Money sol={price} price quote={asset} quoteRate={rate} />} exact={token.priceQuote} note={token.priceStatus === "stale" ? copy.stale : undefined} />
    <Metric label={copy.fdv} value={asset.paired ? <Money sol={fdvSol} quote={asset} quoteRate={rate} /> : rate.status === "fresh" ? formatUsd(fdv) : <span className="money-pair"><span className="money-quote">—</span><small className="money-sol">{rate.status === "stale" ? money.stale : money.missing}</small></span>} />
    <Metric label={copy.volume} value={<Money quote={asset} quoteRate={rate} lamports={token.volumeStatus === "stale" ? null : token.volume24hLamports} />} note={!token.complete || token.volumeStatus === "partial" ? copy.partial : token.volumeStatus === "stale" ? copy.stale : undefined} />
    <Metric label={copy.holders} value={marketNumber(holders, 0)} note={token.holders?.status === "stale" ? copy.stale : token.holders?.status === "partial" ? copy.partial : undefined} />
    <Metric label={money.liquidity} value={<Money quote={asset} quoteRate={rate} lamports={token.liquidityBasis ? token.liquidityLamports ?? null : null} />} note={token.liquidityBasis === "curve-quote-reserve" ? money.curveLiquidity : token.liquidityBasis === "damm-quote-x2" ? money.poolLiquidity : money.unknownLiquidity} />
  </dl>;
}
function Valuation() {
  return <div className="market-valuation"><p>{copy.valuation}</p></div>;
}
export function TokenMarket({ mint, onChain = false }: { mint: string; onChain?: boolean }) {
  const { data, error, notIndexed, reload } = useMarket<MarketToken>(`/api/tokens/${encodeURIComponent(mint)}`);
  return <section className="token-market" aria-label={copy.overview}>
    <div className="market-detail-heading"><h2>{copy.overview}</h2>{data && <span className="market-network">{data.cluster}</span>}</div>
    {!data && notIndexed && onChain ? <DataState compact kind="loading" title={copy.notIndexed} body={copy.notIndexedBody} /> : !data ? <DataState compact kind={error ? "error" : "loading"} title={error ? copy.failed : copy.loading} body={error ? copy.failedBody : copy.loadingBody} onRetry={error ? reload : undefined} /> : <>
      <Snapshot data={data} error={error} onRetry={reload} /><TokenStats token={data.data} observedAt={error ? 0 : data.generatedAtMs} />
      <p className="market-footnote">{sentence(data.data.holders?.definition || copy.sourceNote)} {data.data.holders?.countedAtMs && <>{copy.snapshot} {marketTime(data.data.holders.countedAtMs)}.</>}</p>
      <Valuation />
    </>}
  </section>;
}
export function TokenTrades({ mint, onChain = false, decimals, symbol = null, quote, rate }: { quote?: QuoteAsset; rate?: SolUsdRate; mint: string; onChain?: boolean; decimals: number; symbol?: string | null }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const path = `/api/tokens/${encodeURIComponent(mint)}/trades?${new URLSearchParams({ limit: "12", ...(cursor ? { cursor } : {}) })}`;
  return <section className="market-trades" aria-labelledby="recent-trades-title"><h2 id="recent-trades-title" className="sr-only">{copy.trades}</h2><TradeResults key={path} path={path} onChain={onChain} decimals={decimals} symbol={symbol} quote={quote} rate={rate} cursor={cursor} onCursor={setCursor} /></section>;
}
function TradeResults({ path, decimals, cursor, onCursor, onChain = false, symbol = null, quote, rate }: { quote?: QuoteAsset; rate?: SolUsdRate; path: string; decimals: number; cursor: string | null; onCursor: (c: string | null) => void; onChain?: boolean; symbol?: string | null }) {
  const { data, error, notIndexed, reload } = useMarket<TradeList>(path);
  const [shown, setShown] = useState<MarketEnvelope<TradeList> | null>(null);
  const [fresh, setFresh] = useState<string[]>([]);
  const started = useRef(Date.now() / 1000);
  useEffect(() => { if (data) setShown(old => old ?? data); }, [data]);
  useEffect(() => { if (!fresh.length) return; const t = setTimeout(() => setFresh([]), 1800); return () => clearTimeout(t); }, [fresh]);
  const view = shown ?? data;
  if (!view && notIndexed && onChain) return <DataState compact kind="loading" title={copy.notIndexed} body={copy.notIndexedBody} />;
  if (!view) return <DataState compact kind={error ? "error" : "loading"} title={error ? copy.failed : copy.loading} body={error ? copy.failedBody : copy.loadingBody} onRetry={error ? reload : undefined} />;
  const trades = Array.isArray(view.data?.trades) ? view.data.trades : [];
  const pending = data && JSON.stringify(view.data) !== JSON.stringify(data.data);
  const update = () => { const ids = new Set(trades.map(t => t.id)); setFresh((data?.data.trades ?? []).filter(t => !ids.has(t.id) && (t.blockTimeSec ?? 0) >= started.current).map(t => t.id)); setShown(data); };
  return <><Snapshot data={view} error={error} onRetry={reload} />
    {pending && <button type="button" className="market-update" onClick={update}>{copy.dataUpdated} <strong>{copy.refresh} ↻</strong></button>}
    {view.coverage.status !== "complete" && <p className="market-warning">{copy.historyPending}</p>}
    {trades.length ? <ul className="trade-list">{trades.map(t => <li key={t.id} className={`trade-row trade-row-${t.side}${fresh.includes(t.id) ? " market-new-trade" : ""}`}>
      <span className={`trade-side trade-${t.side}`}>{t.side === "buy" ? copy.buy : copy.sell}</span>
      <span className="trade-main">
        <span className="trade-quote" title={rawUnits(t.quoteAmountLamports, t.quoteDecimals) ?? undefined}><Money lamports={t.quoteAmountLamports} quote={quoteAsset(t.quoteMint, t.quoteDecimals, quote?.mint === t.quoteMint ? quote.symbol : null, quote?.mint === t.quoteMint ? quote.sol : null)} quoteRate={quote?.mint === t.quoteMint ? rate : undefined} /></span>
        <span className="trade-meta">
          <span title={rawUnits(t.baseAmountRaw, decimals) ?? undefined}>{t.baseAmountRaw !== null && /^\d+$/.test(t.baseAmountRaw) ? formatAmount(BigInt(t.baseAmountRaw), decimals, { ticker: symbol ?? undefined, maxFraction: 0 }) : "—"}</span>
          <span>{t.trader ? <a href={EXPLORER("address", t.trader)} target="_blank" rel="noopener noreferrer" aria-label={`${copy.trader} ${t.trader}`}>{short(t.trader)}</a> : copy.unknownTrader}{t.trader && t.traderKind === "feePayer" ? <span className="micro"> · {copy.payer}</span> : null}</span>
        </span>
      </span>
      <span className="trade-end">
        <span className="trade-when" title={marketTime(t.blockTimeSec ? t.blockTimeSec * 1000 : null)}>{ago(t.blockTimeSec)}</span>
        <a className="trade-tx" href={EXPLORER("tx", t.signature)} target="_blank" rel="noopener noreferrer" aria-label={`${copy.receipt} ${t.signature}`}>{t.venue === "curve" ? copy.curveShort : copy.poolShort} ↗</a>
      </span>
    </li>)}</ul> : <DataState compact title={copy.noTrades} body={copy.noTradesBody} />}
    <div className="market-pagination">{cursor && <button type="button" className="button button-secondary" onClick={() => onCursor(null)}>← {copy.first}</button>}{view.data?.nextCursor && <button type="button" className="button button-secondary" onClick={() => onCursor(view.data.nextCursor)}>{copy.more} →</button>}</div><p className="market-footnote">{copy.tradeNote}</p>
  </>;
}
