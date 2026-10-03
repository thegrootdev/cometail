"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Money } from "./Money";
import { CopyAddress } from "./CopyAddress";
import { formatAmount } from "@/lib/amounts";
import { TokenHeading } from "./TokenHeading";
import { SocialLinks } from "./SocialLinks";
import { quoteAsset, quoteRate, type QuoteAsset } from "@/lib/quotes";
import type { SolUsdRate } from "@/lib/usd";
import { formatUsd, usdValue } from "@/lib/usd";
import { market as copy, money } from "@/content/cometail";
import { EXPLORER } from "@/lib/addresses";
import { short } from "@/lib/format";
import { MarketEnvelope, MarketToken, TradeList, TokenList, useMarket, rawUnits, marketNumber, marketTime } from "@/lib/market";
import { DataState, TokenAvatar } from "./Experience";

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
function Stage({ token }: { token: MarketToken }) {
  const stage = token.migrationStage ?? token.stage;
  const progress = typeof token.progressBps === "number" && Number.isFinite(token.progressBps) ? Math.max(0, Math.min(100, token.progressBps / 100)) : null;
  return <div className="market-stage"><div><span>{stage === "graduated" ? copy.pool : stage === "completed" ? copy.completed : stage === "migrating" ? copy.migrating : copy.bonding}</span>
    {stage === "bonding" && <strong>{progress === null ? "—" : `${marketNumber(progress, 1)}%`}</strong>}</div>
    <div className="market-progress" role="progressbar" aria-label={copy.progress} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}>
      <span style={{ width: `${stage === "graduated" ? 100 : progress ?? 0}%` }} />
    </div></div>;
}
function TokenStats({ token, observedAt }: { token: MarketToken; observedAt: number }) {
  const rate = quoteRate(token.quoteUsd, observedAt);
  const asset = quoteAsset(token.quoteMint, token.quoteDecimals);
  const supply = rawUnits(token.totalSupplyRaw, token.decimals);
  const price = token.priceStatus === "stale" || token.priceStatus === "unavailable" ? null : token.priceQuote;
  const fdvSol = supply !== null && price !== null ? Number(supply) * Number(price) : null;
  const fdv = usdValue(fdvSol, rate);
  const holders = token.holders?.status === "unavailable" ? null : token.holders?.count;
  return <dl className="market-stats">
    <Metric label={copy.price} value={<Money sol={price} price quote={asset} quoteRate={rate} />} exact={token.priceQuote} note={token.priceStatus === "stale" ? copy.stale : undefined} />
    <Metric label={copy.fdv} value={rate.status === "fresh" ? formatUsd(fdv) : rate.status === "stale" ? money.stale : money.missing} />
    <Metric label={copy.volume} value={<Money quote={asset} quoteRate={rate} lamports={token.volumeStatus === "stale" ? null : token.volume24hLamports} />} note={!token.complete || token.volumeStatus === "partial" ? copy.partial : token.volumeStatus === "stale" ? copy.stale : undefined} />
    <Metric label={copy.holders} value={marketNumber(holders, 0)} note={token.holders?.status === "stale" ? copy.stale : token.holders?.status === "partial" ? copy.partial : undefined} />
    <Metric label={money.liquidity} value={<Money quote={asset} quoteRate={rate} lamports={token.liquidityBasis ? token.liquidityLamports ?? null : null} />} note={token.liquidityBasis === "curve-quote-reserve" ? money.curveLiquidity : token.liquidityBasis === "damm-quote-x2" ? money.poolLiquidity : money.unknownLiquidity} />
  </dl>;
}
function Valuation() {
  return <div className="market-valuation"><p>{copy.valuation}</p></div>;
}
export function MarketDirectory() {
  // The server advertises comparable ranking only after its worker upgrade.
  const [sort, setSort] = useState<"volume24h" | "newest">("newest");
  const [rankingReady, setRankingReady] = useState(false);
  useEffect(() => { if (!rankingReady) setSort("newest"); }, [rankingReady]);
  const [stage, setStage] = useState("all"), [query, setQuery] = useState(""), [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => { setSearch(query.trim()); setCursor(null); }, 300); return () => clearTimeout(t); }, [query]);
  const params = new URLSearchParams({ sort, stage, q: search, limit: "12" }); if (cursor) params.set("cursor", cursor);
  const path = `/api/tokens?${params}`;
  const clear = () => { setQuery(""); setSearch(""); setStage("all"); setCursor(null); };
  return <section className="market-section" aria-labelledby="market-title">
    <div className="market-heading"><div><span className="eyebrow">{copy.kicker}</span><h2 id="market-title">{copy.title}</h2><p>{copy.body}</p></div><span className="market-orbit" aria-hidden="true">✦</span></div>
    <div className="market-controls">
      <div className="market-switch" aria-label={copy.kicker}>{(["newest", ...(rankingReady ? ["volume24h" as const] : [])] as const).map(s => <button type="button" key={s} aria-pressed={sort === s} onClick={() => { setSort(s); setCursor(null); }}>{s === "volume24h" ? copy.trending : copy.newest}</button>)}</div>
      <label className="market-search"><span>{copy.search}</span><input type="search" placeholder={copy.searchHint} value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label className="market-filter"><span>{copy.all}</span><select value={stage} onChange={e => { setStage(e.target.value); setCursor(null); }}><option value="all">{copy.all}</option><option value="bonding">{copy.bonding}</option><option value="graduated">{copy.graduated}</option></select></label>
    </div>
    <p className="market-sort-note">{sort === "volume24h" ? copy.ranking : copy.newestNote}</p>
    <DirectoryResults key={path} path={path} cursor={cursor} onCursor={setCursor} clear={clear} onRankingReady={setRankingReady} />
  </section>;
}
function DirectoryResults({ path, cursor, onCursor, clear, onRankingReady }: { path: string; cursor: string | null; onCursor: (c: string | null) => void; clear: () => void; onRankingReady: (ready: boolean) => void }) {
  const { data, loading, error, reload } = useMarket<TokenList>(path);
  useEffect(() => { if (data) onRankingReady(data.data.volumeRanking?.basis === "quote-usd-v1"); }, [data, onRankingReady]);
  const [shown, setShown] = useState<MarketEnvelope<TokenList> | null>(null);
  useEffect(() => { if (data) setShown(old => old ?? data); }, [data]);
  const view = shown ?? data;
  const pending = !!(shown && data && JSON.stringify(shown.data) !== JSON.stringify(data.data));
  if (!view) return <DataState kind={error ? "error" : "loading"} title={error ? copy.failed : copy.loading} body={error ? copy.failedBody : copy.loadingBody} onRetry={error ? reload : undefined} />;
  // On worker rollback, discard an incompatible ranking response before rendering it.
  if (path.includes("sort=volume24h") && view.data.volumeRanking?.basis !== "quote-usd-v1") return <DataState compact kind="loading" title={copy.loading} />;
  const tokens = Array.isArray(view.data?.tokens) ? view.data.tokens : [];
  return <><Snapshot data={view} error={error} onRetry={reload} />
    {pending && <button className="market-update" type="button" onClick={() => setShown(data)}>{copy.dataUpdated} <strong>{copy.refresh} ↻</strong></button>}
    {view.coverage.status !== "complete" && <p className="market-warning">{copy.historyPending}</p>}
    {tokens.length ? <div className="market-grid" aria-busy={loading}>{tokens.map(t => <article className="market-card" key={t.mint}>
      <Link className="market-card-link" href={`/token/${t.mint}`} aria-label={`${copy.view} ${t.name || short(t.mint)}`}>
      <div className="market-identity"><TokenHeading token={t} mint={t.mint} large /><span className="market-arrow" aria-hidden="true">↗</span></div><span className="token-kind-note">{t.tokenKind === "stream" ? copy.stream : copy.plain}</span>
      </Link><CopyAddress address={t.mint} /><SocialLinks links={t.links} tokenName={t.name} />
      <TokenStats token={t} observedAt={error ? 0 : view.generatedAtMs} /><Stage token={t} />
    </article>)}</div> : <DataState title={copy.empty} body={copy.emptyBody}><button type="button" className="button button-secondary" onClick={clear}>{copy.clear}</button></DataState>}
    <div className="market-pagination">{cursor && <button type="button" className="button button-secondary" onClick={() => onCursor(null)}>← {copy.first}</button>}{view.data?.nextCursor && <button type="button" className="button button-secondary" onClick={() => onCursor(view.data.nextCursor)}>{copy.more} →</button>}</div>
    <Valuation />
  </>;
}
export function TokenMarket({ mint, onChain = false }: { mint: string; onChain?: boolean }) {
  const { data, error, notIndexed, reload } = useMarket<MarketToken>(`/api/tokens/${encodeURIComponent(mint)}`);
  return <section className="token-market" aria-label={copy.overview}>
    <div className="market-detail-heading"><h2>{copy.overview}</h2>{data && <span className="market-network">{data.cluster}</span>}</div>
    {!data && notIndexed && onChain ? <DataState compact kind="loading" title={copy.notIndexed} body={copy.notIndexedBody} /> : !data ? <DataState compact kind={error ? "error" : "loading"} title={error ? copy.failed : copy.loading} body={error ? copy.failedBody : copy.loadingBody} onRetry={error ? reload : undefined} /> : <>
      <Snapshot data={data} error={error} onRetry={reload} /><TokenStats token={data.data} observedAt={error ? 0 : data.generatedAtMs} />
      <p className="market-footnote">{data.data.holders?.definition || copy.sourceNote} {data.data.holders?.countedAtMs && <>{copy.snapshot} {marketTime(data.data.holders.countedAtMs)}.</>}</p>
      <Valuation />
    </>}
  </section>;
}
export function TokenTrades({ mint, onChain = false, decimals, symbol = null, quote, rate }: { quote?: QuoteAsset; rate?: SolUsdRate; mint: string; onChain?: boolean; decimals: number; symbol?: string | null }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const path = `/api/tokens/${encodeURIComponent(mint)}/trades?${new URLSearchParams({ limit: "12", ...(cursor ? { cursor } : {}) })}`;
  return <section className="market-trades" aria-labelledby="recent-trades-title"><h2 id="recent-trades-title">{copy.trades}</h2><p>{copy.tradesBody}</p><TradeResults key={path} path={path} onChain={onChain} decimals={decimals} symbol={symbol} quote={quote} rate={rate} cursor={cursor} onCursor={setCursor} /></section>;
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
    {trades.length ? <div className="market-trade-scroll"><table className="market-trade-table"><thead><tr><th>{copy.side}</th><th>{copy.amount}</th><th>{copy.quote}</th><th>{copy.venue}</th><th>{copy.when}</th><th>{copy.receipt}</th></tr></thead><tbody>{trades.map(t => <tr key={t.id} className={fresh.includes(t.id) ? "market-new-trade" : undefined}>
      <td data-label={copy.side}><span className={`trade-side trade-${t.side}`}>{t.side === "buy" ? copy.buy : copy.sell}</span></td>
      <td data-label={copy.amount} title={rawUnits(t.baseAmountRaw, decimals) ?? undefined}>{t.baseAmountRaw !== null && /^\d+$/.test(t.baseAmountRaw) ? formatAmount(BigInt(t.baseAmountRaw), decimals, { ticker: symbol ?? undefined, maxFraction: 2 }) : "—"}</td>
      <td data-label={copy.quote} title={rawUnits(t.quoteAmountLamports, t.quoteDecimals) ?? undefined}><Money lamports={t.quoteAmountLamports} quote={quoteAsset(t.quoteMint, t.quoteDecimals, quote?.mint === t.quoteMint ? quote.symbol : null)} quoteRate={quote?.mint === t.quoteMint ? rate : undefined} /></td>
      <td data-label={copy.venue}>{t.venue === "curve" ? copy.curve : copy.pool}</td><td data-label={copy.when}>{marketTime(t.blockTimeSec ? t.blockTimeSec * 1000 : null)}</td>
      <td data-label={copy.receipt}><a href={EXPLORER("tx", t.signature)} target="_blank" rel="noopener noreferrer" aria-label={`${copy.receipt} ${t.signature}`}>{short(t.signature)} ↗</a><small>{t.traderKind === "authority" ? `${copy.trader}: ${t.trader ? short(t.trader) : "—"}` : t.traderKind === "feePayer" ? copy.payer : copy.unknownTrader}</small></td>
    </tr>)}</tbody></table></div> : <DataState compact title={copy.noTrades} body={copy.noTradesBody} />}
    <div className="market-pagination">{cursor && <button type="button" className="button button-secondary" onClick={() => onCursor(null)}>← {copy.first}</button>}{view.data?.nextCursor && <button type="button" className="button button-secondary" onClick={() => onCursor(view.data.nextCursor)}>{copy.more} →</button>}</div><p className="market-footnote">{copy.tradeNote}</p>
  </>;
}
