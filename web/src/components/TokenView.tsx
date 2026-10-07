"use client";
// The simple token page's read-only pieces: four headline numbers (each with its stale / partial
// note), an FDV chart drawn from the latest indexed trades, and the top holders read from the chain.
// Loading, empty, failing (with retry) and last-known states are told apart. Nothing here signs or sends.
import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useMarket, rawUnits, marketNumber, type MarketToken, type TradeList } from "@/lib/market";
import { market as marketCopy } from "@/content/cometail";
import { quoteAsset, quoteRate } from "@/lib/quotes";
import { formatUsd, usdValue } from "@/lib/usd";
import { EXPLORER } from "@/lib/addresses";
import { short } from "@/lib/format";
import { tokenSimple as copy } from "@/content/cometail";
import { compactUsd, fdvValue } from "./CoinFeed";

// Meteora's fixed pool authorities (DBC curve vaults, DAMM v2 pool vaults): their accounts are the coins for sale.
const DBC_POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM";
const DAMM_POOL_AUTHORITY = "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC";

/** FDV, price, 24h volume and holders from the market index, each with the index's own status: "—" when
 *  not known, and a short note when a figure is last known, partial or stale. */
export function QuickStats({ token, observedAt }: { token: MarketToken | null; observedAt: number }) {
  const rate = quoteRate(token?.quoteUsd ?? null, observedAt);
  const asset = token ? quoteAsset(token.quoteMint, token.quoteDecimals) : null;
  const price = token && token.priceStatus !== "unavailable" && token.priceStatus !== "stale" ? token.priceQuote : null;
  const priceUsd = usdValue(price, rate);
  const volume = token && token.volumeStatus !== "stale" ? rawUnits(token.volume24hLamports, token.quoteDecimals ?? 9) : null;
  const volumeUsd = usdValue(volume, rate);
  const holders = token?.holders?.status === "unavailable" ? null : token?.holders?.count ?? null;
  const lastKnown = !!token && !observedAt;
  const fdv = token ? fdvValue(token, observedAt) : null;
  const cell = (label: string, value: string, note: string | null, tone = "") => <div className={`quick-stat ${tone}`}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
  return (
    <div className="quick-stats">
      {cell(copy.fdv, fdv?.text ?? "—", lastKnown ? marketCopy.stale : copy.fdvNote, "is-cap")}
      {cell(copy.price, priceUsd !== null ? formatUsd(priceUsd, true) : price !== null && asset ? `${Number(price).toPrecision(3)} ${asset.symbol}` : "—", token?.priceStatus === "stale" ? marketCopy.stale : lastKnown ? marketCopy.stale : null)}
      {cell(copy.volume, volumeUsd !== null ? compactUsd(volumeUsd) ?? "—" : volume !== null && asset ? `${Number(volume).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${asset.symbol}` : "—",
        !token ? null : token.volumeStatus === "stale" ? marketCopy.stale : !token.complete || token.volumeStatus === "partial" ? marketCopy.partial : lastKnown ? marketCopy.stale : null)}
      {cell(copy.holders, marketNumber(holders, 0), token?.holders?.status === "stale" ? marketCopy.stale : token?.holders?.status === "partial" ? marketCopy.partial : lastKnown ? marketCopy.stale : null)}
    </div>
  );
}

/** FDV over the latest trades: each trade's price × the coin's current total supply (not a historical
 *  circulating cap), in USD at the current reference rate when it is fresh, otherwise in the quote token. */
export function PriceChart({ mint, token, observedAt }: { mint: string; token: MarketToken | null; observedAt: number }) {
  const { data, error, reload } = useMarket<TradeList>(`/api/tokens/${encodeURIComponent(mint)}/trades?limit=100`);
  const rate = quoteRate(token?.quoteUsd ?? null, observedAt);
  const supplyText = token ? rawUnits(token.totalSupplyRaw, token.decimals) : null;
  const supply = supplyText === null ? NaN : Number(supplyText);
  const points = useMemo(() => {
    const trades = Array.isArray(data?.data?.trades) ? data.data.trades : [];
    return trades
      .filter((t) => t.blockTimeSec && t.executionPriceQuote && Number(t.executionPriceQuote) > 0)
      .map((t) => ({ t: t.blockTimeSec as number, v: Number(t.executionPriceQuote) * supply }))
      .filter((p) => Number.isFinite(p.v))
      .reverse();
  }, [data, supply]);
  const symbol = token ? quoteAsset(token.quoteMint, token.quoteDecimals).symbol : "";
  const label = (v: number) => { const usd = usdValue(v, rate); return usd !== null ? compactUsd(usd) ?? "—" : `${v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 0 : 2 })} ${symbol}`; };
  const retry = <button type="button" className="link-button" onClick={reload}>{marketCopy.retry} ↻</button>;
  if (!data) return <div className="chart-card"><p className="chart-empty" role={error ? "alert" : "status"}>{error ? <>{copy.chartFailed} {retry}</> : copy.chartLoading}</p></div>;
  if (!Number.isFinite(supply)) return <div className="chart-card"><p className="chart-empty">{copy.chartNoSupply}</p></div>;
  if (points.length < 2) return <div className="chart-card"><p className="chart-empty">{copy.chartEmpty}</p>{error && <p className="chart-stale" role="status">{marketCopy.stale} · {retry}</p>}</div>;
  const W = 340, H = 150, pad = 6;
  const min = Math.min(...points.map((p) => p.v)), max = Math.max(...points.map((p) => p.v));
  const t0 = points[0].t, t1 = points[points.length - 1].t;
  const x = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * pad);
  const y = (v: number) => pad + (1 - (v - min) / Math.max(max - min, max * 1e-9)) * (H - 2 * pad);
  // a step line: each trade holds its price until the next one
  let d = `M${x(points[0].t).toFixed(1)},${y(points[0].v).toFixed(1)}`;
  for (let i = 1; i < points.length; i++) d += ` H${x(points[i].t).toFixed(1)} V${y(points[i].v).toFixed(1)}`;
  const first = points[0].v, last = points[points.length - 1].v;
  const change = first > 0 ? ((last - first) / first) * 100 : 0;
  const up = change >= 0;
  const time = (s: number) => new Date(s * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <div className={`chart-card ${up ? "is-up" : "is-down"}`}>
      <div className="chart-head">
        <span>{copy.chart}</span>
        <strong>{label(last)}</strong>
        <em>{up ? "+" : ""}{change.toFixed(1)}%</em>
        <small>{copy.chartWindow(points.length)}</small>
      </div>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${copy.chart} ${label(first)} → ${label(last)}`}>
        <defs>
          <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity="0.28" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient>
        </defs>
        <path d={`${d} V${H} H${x(t0).toFixed(1)} Z`} fill="url(#chart-fill)" stroke="none" />
        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <div className="chart-foot"><span>{time(t0)}</span><span>{label(min)} – {label(max)}</span><span>{time(t1)}</span></div>
      {error && <p className="chart-stale" role="status">{marketCopy.stale} · {retry}</p>}
    </div>
  );
}

type Holder = { owner: string; amount: number; pct: number | null };
/** The 20 largest token accounts, read from the chain, with the curve, pool, creator and the viewer named. */
export function HolderList({ mint, creator, decimals }: { mint: string; creator: string | null; decimals: number }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [rows, setRows] = useState<Holder[] | null | "error">(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setRows(null);
    (async () => {
      try {
        const key = new PublicKey(mint);
        const [largest, supply] = await Promise.all([connection.getTokenLargestAccounts(key), connection.getTokenSupply(key)]);
        const accounts = largest.value.filter((a) => a.amount !== "0");
        const parsed = accounts.length ? await connection.getMultipleParsedAccounts(accounts.map((a) => a.address)) : { value: [] };
        const total = Number(supply.value.amount) / 10 ** decimals;
        const out = accounts.map((a, i) => {
          const info = parsed.value[i]?.data as { parsed?: { info?: { owner?: string } } } | undefined;
          const amount = Number(a.amount) / 10 ** decimals;
          return { owner: info?.parsed?.info?.owner ?? a.address.toBase58(), amount, pct: total > 0 ? (amount / total) * 100 : null };
        });
        if (live) setRows(out);
      } catch { if (live) setRows("error"); }
    })();
    return () => { live = false; };
  }, [connection, mint, decimals, tick]);
  if (rows === null) return <p className="chart-empty" role="status">{copy.holdersLoading}</p>;
  if (rows === "error") return <p className="chart-empty" role="alert">{copy.holdersFailed} <button type="button" className="link-button" onClick={() => setTick((n) => n + 1)}>{marketCopy.retry} ↻</button></p>;
  if (!rows.length) return <p className="chart-empty">{copy.holdersNone}</p>;
  const me = publicKey?.toBase58();
  const tag = (o: string) => o === DBC_POOL_AUTHORITY ? copy.curve : o === DAMM_POOL_AUTHORITY ? copy.pool : o === creator ? copy.creator : o === me ? copy.you : null;
  return (
    <>
      <ol className="holder-list">
        {rows.map((h, i) => {
          const t = tag(h.owner);
          return (
            <li key={`${h.owner}-${i}`}>
              <span className="holder-rank">{i + 1}</span>
              <a className="holder-who" href={EXPLORER("address", h.owner)} target="_blank" rel="noopener noreferrer">{short(h.owner)}{t && <span className="holder-tag">{t}</span>}</a>
              <span className="holder-pct">{h.pct === null ? "—" : `${h.pct < 0.01 ? "<0.01" : h.pct.toFixed(2)}%`}</span>
            </li>
          );
        })}
      </ol>
      <p className="micro">{copy.holdersNote}</p>
    </>
  );
}
