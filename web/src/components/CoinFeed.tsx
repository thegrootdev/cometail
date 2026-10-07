"use client";
// The home feed: every launch as a simple card (image, name, ticker, market cap, progress to
// graduation), with search and three tabs. Reads the same /api/tokens list the old directory did;
// "About to graduate" orders the coins still on their curve by progress, closest first.
import Link from "next/link";
import { useEffect, useState } from "react";
import { OFFICIAL_MINT, isListed, isOfficial } from "@/lib/addresses";
import { useMarket, rawUnits, type MarketToken, type TokenList } from "@/lib/market";
import { quoteAsset } from "@/lib/quotes";
import { tickerText } from "@/lib/token-display";
import { short } from "@/lib/format";
import { home as copy, market } from "@/content/cometail";
import { DataState, TokenAvatar } from "./Experience";

type Tab = "new" | "trending" | "soon" | "graduated";
const PAGE = 24;

/** $1.2K / $3.4M style, or null when the value is unknown. */
export function compactUsd(value: string | number | null | undefined): string | null {
  const n = value === null || value === undefined || value === "" ? NaN : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: n >= 1000 ? "compact" : "standard", maximumFractionDigits: n >= 1000 ? 1 : 0 }).format(n);
}
/** Market cap: the worker's USD figure; without a USD rate, price × supply in the quote token. */
export function marketCap(t: MarketToken): string {
  const usd = compactUsd(t.marketCapUsd ?? t.fdvUsd);
  if (usd) return usd;
  const supply = rawUnits(t.totalSupplyRaw, t.decimals);
  if (supply === null || t.priceQuote === null) return "—";
  const n = Number(supply) * Number(t.priceQuote);
  if (!Number.isFinite(n)) return "—";
  return `${n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2 })} ${quoteAsset(t.quoteMint, t.quoteDecimals).symbol}`;
}
export function progressOf(t: MarketToken): number | null {
  const stage = t.migrationStage ?? t.stage;
  if (stage === "graduated" || stage === "completed" || stage === "migrating") return 100;
  return typeof t.progressBps === "number" && Number.isFinite(t.progressBps) ? Math.max(0, Math.min(100, t.progressBps / 100)) : null;
}
function age(ms: number | null): string {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  return s < 3600 ? `${Math.max(1, Math.floor(s / 60))}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

export function CoinCard({ token: t, official = false }: { token: MarketToken; official?: boolean }) {
  const stage = t.migrationStage ?? t.stage;
  const progress = progressOf(t);
  const done = stage === "graduated";
  return (
    <Link className={`coin-card ${official ? "coin-official" : ""}`} href={`/token/${t.mint}`} aria-label={`${market.view} ${t.name || short(t.mint)}`}>
      <TokenAvatar seed={t.mint} image={t.imageUrl || undefined} />
      <span className="coin-main">
        <span className="coin-title">
          <strong>{t.name?.trim() || short(t.mint)}</strong>
          {official ? <span className="coin-badge">{copy.official}</span> : <span className="coin-ticker">{tickerText(t.symbol) || "—"}</span>}
        </span>
        <span className="coin-progress">
          <span className={`coin-bar ${done ? "is-done" : ""}`} role="progressbar" aria-label={market.progress} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}>
            <span style={{ width: `${progress ?? 0}%` }} />
          </span>
          <span className="coin-pct">{done ? copy.graduated : stage === "bonding" ? (progress === null ? "—" : `${progress < 10 ? progress.toFixed(1) : Math.round(progress)}%`) : copy.graduating}</span>
        </span>
      </span>
      <span className="coin-side">
        <span className="coin-cap"><span className="sr-only">{copy.marketCap} </span><strong>{marketCap(t)}</strong></span>
        <span className="coin-age">{t.createdAtMs ? age(t.createdAtMs) : ""}</span>
      </span>
    </Link>
  );
}

export function CoinFeed() {
  const [tab, setTab] = useState<Tab>("new");
  const [query, setQuery] = useState(""), [search, setSearch] = useState("");
  const [count, setCount] = useState(PAGE);
  useEffect(() => { const t = setTimeout(() => setSearch(query.trim()), 300); return () => clearTimeout(t); }, [query]);
  useEffect(() => setCount(PAGE), [tab, search]);
  // the soon tab reads every coin still on its curve (the API caps a page at 100) and orders them here
  // trending ranks by 24h volume in USD (the worker's volume ranking; unrated coins follow, newest first)
  const params = new URLSearchParams({ sort: tab === "trending" ? "volume24h" : "newest", stage: tab === "soon" ? "bonding" : tab === "graduated" ? "graduated" : "all", q: search, limit: String(tab === "soon" ? 100 : Math.min(100, count)) });
  const path = `/api/tokens?${params}`;
  const officialMint = OFFICIAL_MINT && isOfficial(OFFICIAL_MINT.toBase58()) ? OFFICIAL_MINT.toBase58() : null;
  const pinned = !!officialMint && tab === "new" && !search;
  const official = useMarket<MarketToken>(pinned && officialMint ? `/api/tokens/${encodeURIComponent(officialMint)}` : null);
  const { data, error, reload } = useMarket<TokenList>(path);
  let tokens = (Array.isArray(data?.data?.tokens) ? data.data.tokens : []).filter((t) => isListed(t.mint));
  if (tab === "soon") tokens = tokens.filter((t) => (t.migrationStage ?? t.stage) !== "graduated").sort((a, b) => (progressOf(b) ?? -1) - (progressOf(a) ?? -1));
  const listRow = pinned ? tokens.find((t) => t.mint === officialMint) ?? null : null;
  const pin = pinned ? (official.data && !official.error ? official.data.data : listRow ?? official.data?.data ?? null) : null;
  if (pin) tokens = tokens.filter((t) => t.mint !== officialMint);
  const shown = tokens.slice(0, count);
  const more = tab === "soon" ? tokens.length > count : !!data?.data?.nextCursor && count < 100;
  return (
    <section className="coin-feed" aria-labelledby="feed-title">
      <h2 id="feed-title" className="sr-only">{copy.feedTitle}</h2>
      <label className="feed-search">
        <span className="sr-only">{copy.search}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input type="search" placeholder={copy.searchHint} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={copy.search} />
      </label>
      <div className="feed-tabs" role="tablist" aria-label={copy.feedTitle}>
        {(["new", "trending", "soon", "graduated"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{copy.tabs[k]}</button>
        ))}
      </div>
      {tab === "soon" && <p className="feed-note">{copy.soonNote}</p>}
      {tab === "trending" && <p className="feed-note">{copy.trendingNote}</p>}
      {data && tab === "trending" && data.data?.volumeRanking?.basis !== "quote-usd-v1" ? <DataState compact title={copy.trendingOff} body={copy.emptyBody} />
        : !data ? <DataState compact kind={error ? "error" : "loading"} title={error ? market.failed : market.loading} body={error ? market.failedBody : market.loadingBody} onRetry={error ? reload : undefined} />
        : <>
          {(pin || shown.length > 0) ? (
            <div className="coin-list">
              {pin && <CoinCard token={pin} official />}
              {shown.map((t) => <CoinCard key={t.mint} token={t} />)}
            </div>
          ) : <DataState compact title={tab === "soon" && !search ? copy.soonEmpty : copy.empty} body={copy.emptyBody} />}
          {more && <button type="button" className="button button-secondary feed-more" onClick={() => setCount((c) => c + PAGE)}>{copy.showMore}</button>}
          {data.coverage.status !== "complete" && <p className="feed-note">{market.historyPending}</p>}
          {error && <p className="feed-note" role="status">{market.stale} · <button type="button" className="link-button" onClick={reload}>{market.retry} ↻</button></p>}
        </>}
    </section>
  );
}
