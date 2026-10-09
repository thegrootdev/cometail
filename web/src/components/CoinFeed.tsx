"use client";
// The home feed: every launch as a compact row (image, name, ticker, FDV, progress to graduation),
// with search and four tabs. Reads the same /api/tokens list the old directory did and pages it by
// cursor; "About to graduate" reads every coin still on its curve (bounded) and orders them by progress.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { API_URL, CLUSTER, OFFICIAL_MINT, isListed, isOfficial } from "@/lib/addresses";
import { useMarket, normalizeToken, rawUnits, type MarketEnvelope, type MarketToken, type TokenList } from "@/lib/market";
import { quoteAsset, quoteRate } from "@/lib/quotes";
import { usdValue } from "@/lib/usd";
import { shownName, shownSymbol, tickerText } from "@/lib/token-display";
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
/** FDV: current price × total supply (the worker reports no circulating supply, so this is not a
 *  circulating market cap). USD only through a fresh quote rate observed with the data; otherwise the
 *  quote-token figure. A stale or missing price gives no figure at all. */
export function fdvValue(t: MarketToken, observedAt: number): { text: string; usd: boolean } {
  const price = t.priceStatus === "stale" || t.priceStatus === "unavailable" ? null : t.priceQuote;
  const supply = rawUnits(t.totalSupplyRaw, t.decimals);
  const quote = supply !== null && price !== null ? Number(supply) * Number(price) : null;
  if (quote === null || !Number.isFinite(quote)) return { text: "—", usd: false };
  const usd = compactUsd(usdValue(quote, quoteRate(t.quoteUsd, observedAt)));
  if (usd) return { text: usd, usd: true };
  return { text: `${quote.toLocaleString("en-US", { maximumFractionDigits: quote >= 100 ? 0 : 2 })} ${quoteAsset(t.quoteMint, t.quoteDecimals).symbol}`, usd: false };
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

/** One row. observedAt is when its data was read (0 when the read behind it is failing: last known). */
export function CoinCard({ token: t, observedAt, official = false }: { token: MarketToken; observedAt: number; official?: boolean }) {
  const stage = t.migrationStage ?? t.stage;
  const progress = progressOf(t);
  const done = stage === "graduated";
  const fdv = fdvValue(t, observedAt);
  const lastKnown = !observedAt;
  return (
    <Link className={`coin-card ${official ? "coin-official" : ""} ${lastKnown ? "is-last-known" : ""}`} href={`/token/${t.mint}`} aria-label={`${market.view} ${shownName(t.mint, t.name) || short(t.mint)}`}>
      <TokenAvatar seed={t.mint} image={t.imageUrl || undefined} />
      <span className="coin-main">
        <span className="coin-title">
          <strong>{shownName(t.mint, t.name?.trim()) || short(t.mint)}</strong>
          {official ? <span className="coin-badge">{copy.official}</span> : <span className="coin-ticker">{tickerText(shownSymbol(t.mint, t.symbol)) || "—"}</span>}
        </span>
        <span className="coin-progress">
          <span className={`coin-bar ${done ? "is-done" : ""}`} role="progressbar" aria-label={market.progress} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}>
            <span style={{ width: `${progress ?? 0}%` }} />
          </span>
          <span className="coin-pct">{done ? copy.graduated : stage === "bonding" ? (progress === null ? "—" : `${progress < 10 ? progress.toFixed(1) : Math.round(progress)}%`) : copy.graduating}</span>
        </span>
      </span>
      <span className="coin-side">
        <span className="coin-cap"><strong>{fdv.text}</strong></span>
        <span className="coin-age"><abbr title={copy.fdvTitle}>{copy.fdv}</abbr>{lastKnown ? ` · ${copy.lastKnown}` : t.createdAtMs ? ` · ${age(t.createdAtMs)}` : ""}</span>
      </span>
    </Link>
  );
}

type Page = { tokens: MarketToken[]; next: string | null; observedAt: number; envelope: MarketEnvelope<TokenList> };
/** One list page outside the polling hook (older pages and the bonding sweep), validated like useMarket's. */
async function readPage(path: string, teardown?: AbortSignal): Promise<Page> {
  // every read times out after 12 s, and also stops when its caller tears down
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  const stop = () => controller.abort();
  if (teardown?.aborted) controller.abort(); else teardown?.addEventListener("abort", stop, { once: true });
  try { return await readPageOnce(path, controller.signal); }
  finally { clearTimeout(timer); teardown?.removeEventListener("abort", stop); }
}
async function readPageOnce(path: string, signal: AbortSignal): Promise<Page> {
  const r = await fetch(`${API_URL}${path}`, { cache: "no-store", signal });
  if (!r.ok) throw new Error("Market read failed");
  const env = await r.json() as MarketEnvelope<TokenList>;
  if (env.schemaVersion !== 1 || env.cluster !== CLUSTER || !env.coverage || !env.data || !Array.isArray(env.data.tokens)) throw new Error("Invalid token list");
  const tokens = (env.data.tokens as unknown[]).map(normalizeToken);
  return { tokens, next: env.data.nextCursor ?? null, observedAt: env.generatedAtMs, envelope: env };
}
const listPath = (sort: string, stage: string, q: string, limit: number, cursor?: string | null) =>
  `/api/tokens?${new URLSearchParams({ sort, stage, q, limit: String(limit), ...(cursor ? { cursor } : {}) })}`;

export function CoinFeed() {
  const [tab, setTab] = useState<Tab>("new");
  const [query, setQuery] = useState(""), [search, setSearch] = useState("");
  useEffect(() => { const t = setTimeout(() => setSearch(query.trim()), 300); return () => clearTimeout(t); }, [query]);
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
      {tab === "soon" ? <SoonList key={search} search={search} /> : <PagedList key={`${tab}|${search}`} tab={tab} search={search} />}
    </section>
  );
}

/** New, Trending and Graduated: the first page polls; Show more follows the API's cursor and appends. */
function PagedList({ tab, search }: { tab: Exclude<Tab, "soon">; search: string }) {
  const sort = tab === "trending" ? "volume24h" : "newest", stage = tab === "graduated" ? "graduated" : "all";
  const officialMint = OFFICIAL_MINT && isOfficial(OFFICIAL_MINT.toBase58()) ? OFFICIAL_MINT.toBase58() : null;
  const pinned = !!officialMint && tab === "new" && !search;
  const official = useMarket<MarketToken>(pinned && officialMint ? `/api/tokens/${encodeURIComponent(officialMint)}` : null);
  const { data: live, error, reload } = useMarket<TokenList>(listPath(sort, stage, search, PAGE));
  const [older, setOlder] = useState<Page[]>([]);
  // once older pages hang off the first page's cursor, the first page is frozen at that snapshot (a refresh
  // could otherwise push a coin across the page boundary and lose it); newer data waits behind Show updates
  const [frozen, setFrozen] = useState<MarketEnvelope<TokenList> | null>(null);
  const [paging, setPaging] = useState<"idle" | "busy" | "error">("idle");
  // Show updates starts a new generation: a page read begun before it never lands on the new head
  const generation = useRef(0);
  const data = frozen ?? live;
  const firstObserved = frozen ? frozen.generatedAtMs : error ? 0 : live?.generatedAtMs ?? 0;
  const updated = !!(frozen && live && JSON.stringify(live.data) !== JSON.stringify(frozen.data));
  const cursor = older.length ? older[older.length - 1].next : data?.data?.nextCursor ?? null;
  const more = async () => {
    if (!cursor || paging === "busy" || !data) return;
    // freeze the head this cursor came from now, so a poll landing while the page is in flight cannot move it
    if (!frozen) setFrozen(data);
    const g = generation.current;
    setPaging("busy");
    try {
      const p = await readPage(listPath(sort, stage, search, PAGE, cursor));
      // an appended Trending page must carry the same comparable ranking as the first
      if (tab === "trending" && p.envelope.data.volumeRanking?.basis !== "quote-usd-v1") throw new Error("Incompatible ranking");
      if (g !== generation.current) return;
      setOlder((o) => [...o, p]); setPaging("idle");
    } catch { if (g === generation.current) setPaging("error"); }
  };
  const showUpdates = () => { if (paging === "busy") return; generation.current++; setOlder([]); setFrozen(null); setPaging("idle"); };
  if (data && tab === "trending" && data.data?.volumeRanking?.basis !== "quote-usd-v1") return <DataState compact title={copy.trendingOff} body={copy.emptyBody} />;
  if (!data) return <DataState compact kind={error ? "error" : "loading"} title={error ? market.failed : market.loading} body={error ? market.failedBody : market.loadingBody} onRetry={error ? reload : undefined} />;
  // rows in order, each with the observation time of the read it came from; a coin seen on an earlier page is not repeated
  const seen = new Set<string>();
  const rows: { token: MarketToken; observedAt: number }[] = [];
  for (const [list, at] of [[data.data.tokens, firstObserved] as const, ...older.map((p) => [p.tokens, p.observedAt] as const)])
    for (const t of Array.isArray(list) ? list : []) if (isListed(t.mint) && !seen.has(t.mint)) { seen.add(t.mint); rows.push({ token: t, observedAt: at }); }
  // the official coin pinned on the plain New tab: its own read when healthy, else the list's row, else the cached read marked last known
  const listRow = pinned ? rows.find((r) => r.token.mint === officialMint) ?? null : null;
  const pin = !pinned ? null
    : official.data && !official.error ? { token: official.data.data, observedAt: official.data.generatedAtMs }
    : listRow ? listRow
    : official.data ? { token: official.data.data, observedAt: 0 }
    : null;
  const shown = pin ? rows.filter((r) => r.token.mint !== officialMint) : rows;
  return (
    <>
      {tab === "trending" && <p className="feed-note">{copy.trendingNote}</p>}
      {updated && <button type="button" className="market-update feed-update" disabled={paging === "busy"} onClick={showUpdates}>{market.dataUpdated} <strong>{market.refresh} ↻</strong></button>}
      {(pin || shown.length > 0) ? (
        <div className="coin-list">
          {pin && <CoinCard token={pin.token} observedAt={pin.observedAt} official />}
          {shown.map((r) => <CoinCard key={r.token.mint} token={r.token} observedAt={r.observedAt} />)}
        </div>
      ) : <DataState compact title={copy.empty} body={copy.emptyBody} />}
      {cursor && <button type="button" className="button button-secondary feed-more" disabled={paging === "busy"} onClick={() => void more()}>{paging === "error" ? `${market.retry} ↻` : copy.showMore}</button>}
      {paging === "error" && <p className="feed-note" role="status">{market.failedBody}</p>}
      {data.coverage.status !== "complete" && <p className="feed-note">{market.historyPending}</p>}
      {error && <p className="feed-note" role="status">{market.stale} · <button type="button" className="link-button" onClick={reload}>{market.retry} ↻</button></p>}
    </>
  );
}

/** About to graduate: every coin still on its curve, read page by page (at most SWEEP_PAGES pages),
 *  ordered by progress here; refreshed every minute while the page is visible. */
const SWEEP_PAGES = 10;
function SoonList({ search }: { search: string }) {
  const [state, setState] = useState<{ tokens: MarketToken[]; observedAt: number; truncated: boolean; partial: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const [count, setCount] = useState(PAGE);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // per run: a search change, a retry or unmount ends this run, cancels its reads and voids its late results
    let alive = true;
    const controller = new AbortController();
    let busy = false, latest = 0;
    const sweep = async () => {
      if (document.visibilityState !== "visible" || busy) return;
      busy = true; const seq = ++latest;
      try {
        const tokens: MarketToken[] = []; let cursor: string | null = null, pages = 0, observedAt = Date.now(), partial = false;
        do {
          const p = await readPage(listPath("newest", "bonding", search, 100, cursor), controller.signal);
          tokens.push(...p.tokens); cursor = p.next; pages++; observedAt = Math.min(observedAt, p.observedAt);
          if (p.envelope.coverage.status !== "complete") partial = true;
        } while (cursor && pages < SWEEP_PAGES);
        if (alive && seq === latest) { setState({ tokens, observedAt, truncated: !!cursor, partial }); setFailed(false); }
      } catch { if (alive && seq === latest) setFailed(true); }
      finally { busy = false; }
    };
    void sweep();
    const t = setInterval(() => void sweep(), 60_000);
    return () => { alive = false; controller.abort(); clearInterval(t); };
  }, [search, tick]);
  if (!state) return <DataState compact kind={failed ? "error" : "loading"} title={failed ? market.failed : market.loading} body={failed ? market.failedBody : market.loadingBody} onRetry={failed ? () => setTick((n) => n + 1) : undefined} />;
  const seen = new Set<string>();
  const ranked = state.tokens
    .filter((t) => isListed(t.mint) && (t.migrationStage ?? t.stage) !== "graduated" && !seen.has(t.mint) && (seen.add(t.mint), true))
    .sort((a, b) => (progressOf(b) ?? -1) - (progressOf(a) ?? -1));
  const at = failed ? 0 : state.observedAt;
  return (
    <>
      <p className="feed-note">{state.truncated ? copy.soonTruncated(SWEEP_PAGES * 100) : copy.soonNote}</p>
      {ranked.length ? (
        <div className="coin-list">{ranked.slice(0, count).map((t) => <CoinCard key={t.mint} token={t} observedAt={at} />)}</div>
      ) : <DataState compact title={search ? copy.empty : copy.soonEmpty} body={copy.emptyBody} />}
      {ranked.length > count && <button type="button" className="button button-secondary feed-more" onClick={() => setCount((c) => c + PAGE)}>{copy.showMore}</button>}
      {state.partial && <p className="feed-note">{market.historyPending}</p>}
      {failed && <p className="feed-note" role="status">{market.stale} · <button type="button" className="link-button" onClick={() => setTick((n) => n + 1)}>{market.retry} ↻</button></p>}
    </>
  );
}
