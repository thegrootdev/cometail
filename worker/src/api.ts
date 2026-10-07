// The site's read API, served next to the indexer. JSON only, GET only, no writes.
//   GET /api/sky?limit=200          the Sky scan, by claimable backlog
//   GET /api/vaults                 every vault snapshot
//   GET /api/vaults/:vault          one vault with its streams and latest events
//   GET /api/events?vault=&limit=   events, newest first
//   GET /api/health
//   GET /api/prices                 SOL/USD for display, with its source and age
//   GET /api/tokens?sort=volume24h|newest&stage=bonding|graduated|all&q=&limit=&cursor=   launches in scope
//   GET /api/tokens/:mint            one launch
//   GET /api/tokens/:mint/trades?limit=&cursor=   its trades, newest first
//   Token answers carry an envelope: schemaVersion, cluster, generatedAtMs, observedSlot, coverage, solUsd, data.
//   GET /api/metrics                the submission metrics, independent actors apart from the demo set
// It binds to the loopback interface and expects a reverse proxy in front for TLS. CORS is
// limited to the configured origins, and each client address gets a token bucket; the
// client address is taken from X-Forwarded-For only when the connection comes from loopback.
import type { FeeIndex } from "./feeindex";
import { ESTIMATE_BASIS } from "./fee-basis";
import http from "http";
import net from "net";
import { Store, TokenRow, TradeRow } from "./store";
import { attachFeed, parseCursor, replay, parseTypes, FEED_TYPES } from "./feed";
import { executionPrice } from "./tokens";
import { log } from "./tx";

export interface ApiOptions { host: string; port: number; origins: string[]; ratePerMinute: number; demoActors?: string[]; plainConfigs?: string[]; cluster?: string; feeIndex?: FeeIndex | null; burnView?: (() => Promise<unknown>) | null; burnHistory?: ((kind: "burns" | "splits", before: string | null, limit: number) => Promise<unknown | "invalid">) | null }

class Buckets {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private perMinute: number, private burst: number) {}
  take(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 60_000) * this.perMinute);
    b.at = now;
    if (b.tokens < 1) { this.buckets.set(key, b); return false; }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) for (const [k, v] of this.buckets) if (now - v.at > 300_000) this.buckets.delete(k);
    return true;
  }
}

/**
 * Nothing else may answer on the API port: the proxy in front forwards every /api/* request
 * there, so a stranger on the port would be published. The worker refuses to start when the
 * port already answers or cannot be bound.
 */
async function refuseIfTaken(host: string, port: number): Promise<void> {
  const taken = await new Promise<boolean>((resolve) => {
    const s = net.connect({ host, port });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.setTimeout(2_000, () => { s.destroy(); resolve(false); });
  });
  if (taken) throw new Error(`API port ${host}:${port} is already in use by another process; refusing to start`);
}

/** The metrics of PLAN 8.7, each line independent versus demo by the actor that owns it: a launch by
 *  its creator (a vault-held launch by that vault's depositor), a vault (its income, bids, fills,
 *  burns, refunds) by its depositor. A line whose owner cannot be resolved yet (an event before its
 *  vault's snapshot, a program-held launch without a vault record) is "unattributed", never
 *  independent, and the document says so. One-time proceeds (migration surplus, one-time claims)
 *  are reported apart from recurring income. Stream-token buyers come from the trade index of every
 *  vault's graduated pool. */
export async function metrics(store: Store, demo: Set<string>, plainConfigs: Set<string>) {
  type Cls = "independent" | "demo" | "unattributed";
  const cls = (actor: string | undefined | null): Cls => (!actor ? "unattributed" : demo.has(actor) ? "demo" : "independent");
  const triple = () => ({ independent: 0n, demo: 0n, unattributed: 0n });
  const counts = () => ({ independent: 0, demo: 0, unattributed: 0 });
  const str = (p: Record<Cls, bigint>) => ({ independent: p.independent.toString(), demo: p.demo.toString(), unattributed: p.unattributed.toString() });
  const [vaults, streams, sky, recurringEvents, oneTimeEvents, settled, trades, poolCursors] = await Promise.all([store.listVaults(), store.listAllStreams(), store.listSky(100_000), store.listEventsSince(["harvested"], 0), store.listEventsSince(["oneTimeHarvested"], 0), store.listEventsSince(["settled"], 0), store.listTrades(null, 1_000_000), store.listPoolCursors()]);
  // a pool is pending while catching up, after an interrupted pass, before its first successful
  // catch-up, or when a known graduated pool has no cursor row yet
  const cursorOf = new Map(poolCursors.map((c) => [c.key, c.cursor]));
  const DEFAULT_KEY = "11111111111111111111111111111111";
  let catchingUp = poolCursors.filter((c) => c.cursor.status !== "ok").length;
  for (const v of vaults) { const p = v.data?.dammPool; if (p && String(p) !== DEFAULT_KEY && !cursorOf.has(String(p))) catchingUp++; }
  const vaultClass = new Map<string, Cls>(vaults.map((v) => [v.vault, cls(v.data?.depositor ? String(v.data.depositor) : null)]));
  const ofVault = (vault: string | null | undefined): Cls => (vault && vaultClass.get(vault)) || "unattributed";
  const own = new Map(streams.map((s) => [s.stream, !!s.data.isOwn]));
  const launches = counts(), launchFees = triple();
  // fees and volumes are sums of quote units, so they are kept per quote: the lamport totals are
  // WSOL-quoted launches only; every other quote gets its own raw total under its mint
  const WSOL_MINT = "So11111111111111111111111111111111111111112";
  const byQuote = new Map<string, { count: Record<Cls, number>; tradingFeeRaw: Record<Cls, bigint> }>();
  for (const r of sky) if ((r.kind ?? "curve") === "curve" && plainConfigs.has(r.config)) {
    // a program-held creator is a vault PDA: the launch belongs to that vault's depositor, or is
    // unattributed until the vault record exists; a wallet creator classifies by itself
    // without a vault record only a wallet-held creator is a resolved owner; program or unknown custody is unattributed
    const c: Cls = r.vault ? ofVault(r.vault) : r.custody === "wallet" ? cls(r.creator) : "unattributed";
    launches[c]++;
    const quote = r.quoteMint ?? WSOL_MINT;
    if (quote === WSOL_MINT) launchFees[c] += BigInt(r.tradingFeeLamports);
    else { const q = byQuote.get(quote) ?? { count: counts(), tradingFeeRaw: triple() }; q.count[c]++; q.tradingFeeRaw[c] += BigInt(r.tradingFeeLamports); byQuote.set(quote, q); }
  }
  const recurring = { external: triple(), own: triple() }, oneTime = { external: triple(), own: triple() };
  for (const e of recurringEvents) { const c = ofVault(e.vault); (own.get(String(e.data.stream)) ? recurring.own : recurring.external)[c] += BigInt(e.data.gross ?? 0); }
  for (const e of oneTimeEvents) { const c = ofVault(e.vault); (own.get(String(e.data.stream)) ? oneTime.own : oneTime.external)[c] += BigInt(e.data.gross ?? 0); }
  const depositors = { independent: new Set<string>(), demo: new Set<string>() };
  const depth = triple(), refunded = triple(), burned = triple(), fills = counts();
  let unknownBins = 0, unavailableLadders = 0;
  for (const v of vaults) {
    const c = vaultClass.get(v.vault)!;
    if (c !== "unattributed") depositors[c].add(String(v.data.depositor));
    const ladder = v.data?.live?.ladder;
    // no live view at all, or a pair whose orders could not be read: the depth is unknown, not zero
    if (!v.data?.live || (ladder && ladder.status !== "ok" && ladder.status !== undefined)) unavailableLadders++;
    else { depth[c] += BigInt(ladder?.restingLamports ?? 0); unknownBins += Number(ladder?.unknownBins ?? 0); }
    refunded[c] += BigInt(v.data?.accounting?.refundedPrincipal ?? 0);
  }
  for (const e of settled) { const c = ofVault(e.vault); const b = BigInt(e.data.burned ?? 0); if (b > 0n) fills[c]++; burned[c] += b; }
  // buyers of stream tokens: distinct traders of purchases on the vaults' graduated pools, by the
  // trader's own class (the fee payer is always known), with the quote they paid
  // only a swap's own signer is a buyer; a purchase known by its fee payer alone (a sponsored or
  // routed swap whose signer could not be paired) is unattributed
  // PLAN 8.7 buyers are stream-token buyers: trades on the vaults' pools; plain-launch traders are
  // reported apart so the expanded trade index does not inflate the line
  const buyerSets = { independent: new Set<string>(), demo: new Set<string>(), unattributed: new Set<string>() };
  const buyVolume = triple(); let buys = 0, sells = 0;
  const launchTraders = { independent: new Set<string>(), demo: new Set<string>(), unattributed: new Set<string>() }; let launchTrades = 0;
  for (const t of trades) {
    if (!t.vault) { launchTrades++; const c: Cls = t.traderKind === "authority" ? cls(t.trader) : "unattributed"; launchTraders[c].add(t.trader); continue; }
    if (!t.buy) { sells++; continue; }
    buys++;
    const c: Cls = t.traderKind === "authority" ? cls(t.trader) : "unattributed";
    buyerSets[c].add(t.trader); buyVolume[c] += BigInt(t.amountIn);
  }
  const unattributed = launches.unattributed > 0 || fills.unattributed > 0 || buyerSets.unattributed.size > 0 || [launchFees, recurring.external, recurring.own, oneTime.external, oneTime.own, depth, refunded, burned].some((t) => t.unattributed > 0n);
  // DBC books the trading fee net of its 20% protocol share, so the flat 1% curve fee implies
  // volume = net fee x 125; still an estimate, subject to per-trade rounding
  const volume = (t: Record<Cls, bigint>) => str({ independent: t.independent * 125n, demo: t.demo * 125n, unattributed: t.unattributed * 125n });
  return {
    generatedAt: Date.now(), demoActors: [...demo],
    incomplete: unattributed || unknownBins > 0 || unavailableLadders > 0 || catchingUp > 0,
    notes: [
      "independent and demo are decided by the actor that owns each line: launches by creator (a vault-held launch by its depositor), vaults by depositor; owners not yet resolved are unattributed, never independent",
      "buyers are the distinct signers of stream-token purchases on the vaults' own pools (the stream token's DBC curve and its graduated DAMM v2 pool), classified by the signer wallet; a purchase known only by its fee payer is unattributed; sells are counted, not attributed; trades of other launches are launchTraders",
      ...(catchingUp > 0 ? [`trade history is pending on ${catchingUp} pool(s) (catching up, interrupted, or never covered); buyers and purchases are partial`] : []),
      "launch volume is an estimate: the flat 1% curve fee, booked by DBC net of its 20% protocol share, implies net fee x 125",
      "bid depth is the unfilled principal of every resting bin from the bin arrays, the same accounting settle applies",
      ...(unknownBins > 0 ? [`${unknownBins} bin(s) could not be read; their depth is not counted`] : []),
      ...(unavailableLadders > 0 ? [`${unavailableLadders} vault ladder(s) could not be read this pass; their depth is not counted`] : []),
    ],
    plainLaunches: { count: launches, tradingFeeLamports: str(launchFees), volumeEstimateLamports: volume(launchFees), denomination: "counts cover every quote; the lamport totals and the volume estimate cover WSOL-quoted launches only",
      byQuote: Object.fromEntries([...byQuote.entries()].map(([mint, q]) => [mint, { count: q.count, tradingFeeRaw: str(q.tradingFeeRaw), volumeEstimateRaw: volume(q.tradingFeeRaw) }])) },
    recurringIncomeLamports: { external: str(recurring.external), own: str(recurring.own) },
    oneTimeProceedsLamports: { external: str(oneTime.external), own: str(oneTime.own) },
    depositors: { independent: depositors.independent.size, demo: depositors.demo.size },
    buyers: { distinct: { independent: buyerSets.independent.size, demo: buyerSets.demo.size, unattributed: buyerSets.unattributed.size }, buyVolumeLamports: str(buyVolume), purchases: buys, sales: sells, poolsPending: catchingUp },
    launchTraders: { distinct: { independent: launchTraders.independent.size, demo: launchTraders.demo.size, unattributed: launchTraders.unattributed.size }, trades: launchTrades },
    bidDepthLamports: str(depth),
    fillsAndBurns: { settledWithBurn: fills, burnedSt: str(burned) },
    refundedPrincipalLamports: str(refunded),
  };
}

let metricsMemo: { at: number; value: unknown } | null = null;
let priceMemo: { at: number; value: { solUsd: number; source: string; at: number } } | null = null;

/** SOL/USD for display only (market cap and USD columns): Jupiter's public price API first,
 *  CoinGecko as the fallback, cached for 60 s, never a transaction input. */
export async function solUsd(): Promise<{ solUsd: number; source: string; at: number } | null> {
  if (priceMemo && Date.now() - priceMemo.at < 60_000) return priceMemo.value;
  const tries: [string, string, (j: any) => number][] = [
    ["jupiter", "https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112", (j) => Number(j?.So11111111111111111111111111111111111111112?.usdPrice)],
    ["coingecko", "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", (j) => Number(j?.solana?.usd)],
  ];
  for (const [source, url, pick] of tries) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6_000), headers: { accept: "application/json" } });
      if (!r.ok) continue;
      const v = pick(await r.json());
      if (Number.isFinite(v) && v > 0) { priceMemo = { at: Date.now(), value: { solUsd: v, source, at: Date.now() } }; return priceMemo.value; }
    } catch (e) { log("price source failed", { source, error: String((e as Error).message ?? e) }); }
  }
  return priceMemo?.value ?? null;
}


/** The small identity of every token in the index, by mint and by either of its pools, for the Sky and vault answers. */
async function tokenIdentities(store: Store) {
  const byMint = new Map<string, { mint: string; name: string; symbol: string; imageUrl: string | null; stage: string; links: TokenRow["links"] }>();
  const byPool = new Map<string, { mint: string; name: string; symbol: string; imageUrl: string | null; stage: string; links: TokenRow["links"] }>();
  for (const t of await store.listTokens()) {
    const id = { mint: t.mint, name: t.name, symbol: t.symbol, imageUrl: t.imageUrl, stage: t.stage, links: t.links ?? null };
    byMint.set(t.mint, id); byPool.set(t.dbcPool, id); if (t.dammPool) byPool.set(t.dammPool, id);
  }
  return { byMint, byPool };
}

/** The envelope every token answer carries: what the numbers are, how complete they are, and the SOL price used for USD columns. */
async function envelope(store: Store, opts: ApiOptions, data: unknown) {
  const cursors = await store.listPoolCursors();
  const pending = cursors.filter((c) => c.cursor.status !== "ok").length;
  const price = await solUsd();
  const observed = await store.observedSlot();
  // the time of the last completed token scan, written by the indexer, not the request time
  const scanned = Number(await store.getMeta("tokens_scanned_at")) || null;
  return {
    schemaVersion: 1, cluster: opts.cluster ?? "devnet", generatedAtMs: Date.now(), observedSlot: observed,
    coverage: { status: pending > 0 ? "partial" : scanned ? "complete" : "stale", pendingPools: pending, lastSuccessfulAtMs: scanned },
    solUsd: price ? { value: price.solUsd, source: price.source, observedAtMs: price.at, status: Date.now() - price.at < 10 * 60_000 ? "fresh" : "stale", valuationBasis: (opts.cluster ?? "devnet") === "mainnet-beta" ? "market" : "reference" } : null,
    data,
  };
}
const WSOL = "So11111111111111111111111111111111111111112";
const USDC_MINTS = new Set((process.env.COMETAIL_USDC_MINTS ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").split(",").map((x) => x.trim()).filter(Boolean));
/** USD per one quote unit: the SOL reference for WSOL, 1 for a configured dollar stablecoin, unknown otherwise. */
function quoteUsdRate(quoteMint: string, solUsd: number | null): { value: number | null; source: string | null; status: "fresh" | "missing" } {
  if (quoteMint === WSOL) return { value: solUsd, source: solUsd === null ? null : "sol-reference", status: solUsd === null ? "missing" : "fresh" };
  if (USDC_MINTS.has(quoteMint)) return { value: 1, source: "stablecoin", status: "fresh" };
  return { value: null, source: null, status: "missing" };
}
function tokenView(t: TokenRow, solUsd: number | null) {
  const supply = BigInt(t.totalSupplyRaw);
  const quoteUsd = quoteUsdRate(t.quoteMint, solUsd);
  const priceQuote = t.priceQuote ?? t.priceSol;
  let fdvUsd: string | null = null;
  if (priceQuote && quoteUsd.value) {
    // price (12 decimals) x whole tokens x SOL/USD, kept as a decimal string with 2 places
    const price = BigInt(Math.round(Number(priceQuote) * 1e12));
    const whole = supply / 10n ** BigInt(t.decimals);
    const usd = (price * whole * BigInt(Math.round(quoteUsd.value * 100))) / 10n ** 12n;
    fdvUsd = (Number(usd) / 100).toFixed(2);
  }
  return {
    identity: { mint: t.mint, decimals: t.decimals, name: t.name, symbol: t.symbol, imageUrl: t.imageUrl, metadataUri: t.metadataUri, metadataStatus: t.metadataStatus, creator: t.creator, custody: t.custody, createdAtMs: t.createdAtMs, dbcPool: t.dbcPool, dammPool: t.dammPool, quoteMint: t.quoteMint, tokenKind: t.tokenKind, config: t.config, vault: t.vault, stage: t.stage, links: t.links ?? null },
    market: { priceSol: t.priceSol, priceQuote, quoteMint: t.quoteMint, quoteDecimals: t.quoteDecimals ?? 9, quoteUsd, priceSource: t.priceSource, priceAtMs: t.priceAtMs, totalSupplyRaw: t.totalSupplyRaw, circulatingSupplyRaw: null, fdvUsd, marketCapUsd: null, valuationBasis: "fdv", liquidityLamports: t.liquidityLamports ?? null, liquidityBasis: t.liquidityBasis ?? null },
    volume24h: { lamports: t.volume24hLamports, buys: t.buys24h, sells: t.sells24h, windowEndMs: t.updatedAt, windowStartMs: t.updatedAt - 24 * 3600_000, complete: t.volumeComplete, status: t.volumeComplete ? "complete" : "partial" },
    holders: { count: t.holders, countedAtMs: t.holdersAtMs, status: t.holders === null ? "missing" : "ok", definition: "unique owners of token accounts with a nonzero balance of the mint, excluding the pools' own vaults; addresses, not people" },
    bonding: { progressBps: t.progressBps, quoteRaisedLamports: t.quoteRaisedLamports, targetLamports: t.targetLamports, migrationStage: t.stage === "graduated" ? "graduated" : t.stage === "completed" ? "completed" : "bonding" },
    updatedAtMs: t.updatedAt,
  };
}
/** A trade's quote fields, derived from the token it belongs to when the stored row lacks them
 *  (the trades table carries no quote columns; the decoder's values live only in the feed). */
function withQuote(t: TradeRow, token: TokenRow | null): TradeRow {
  if (t.quoteMint && t.quoteDecimals !== undefined && t.executionPriceQuote !== undefined) return t;
  const quoteMint = t.quoteMint ?? token?.quoteMint ?? WSOL;
  const quoteDecimals = t.quoteDecimals ?? token?.quoteDecimals ?? 9;
  const base = t.baseAmountRaw ? BigInt(t.baseAmountRaw) : 0n, quote = t.quoteAmountLamports ? BigInt(t.quoteAmountLamports) : 0n;
  const executionPriceQuote = t.executionPriceQuote ?? (token && base > 0n ? executionPrice(quote, base, token.decimals, quoteDecimals) : t.executionPriceSol ?? null);
  return { ...t, quoteMint, quoteDecimals, executionPriceQuote, executionPriceSol: quoteMint === WSOL ? (t.executionPriceSol ?? executionPriceQuote) : null };
}
function tradeView(t: TradeRow) {
  return { id: `${t.signature}:${t.idx}:${t.pool}`, signature: t.signature, ordinal: t.idx, slot: t.slot, blockTimeSec: t.blockTime, pool: t.pool, venue: t.venue ?? null, side: t.buy ? "buy" : "sell", baseAmountRaw: t.baseAmountRaw ?? null, quoteAmountLamports: t.quoteAmountLamports ?? null, executionPriceSol: t.executionPriceSol ?? null, executionPriceQuote: t.executionPriceQuote ?? t.executionPriceSol ?? null, quoteMint: t.quoteMint ?? WSOL, quoteDecimals: t.quoteDecimals ?? 9, trader: t.trader, traderKind: t.traderKind };
}
async function tokenRoutes(store: Store, opts: ApiOptions, url: URL, send: (code: number, body: unknown, extra?: Record<string, string>) => void) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const reference = await solUsd();
  const price = reference && Date.now() - reference.at < 10 * 60_000 ? reference : null;
  const parts = url.pathname.split("/").filter(Boolean); // api, tokens, [mint], [trades]
  if (parts.length === 2) {
    const sort = url.searchParams.get("sort") === "newest" ? "newest" : "volume24h";
    const stage = url.searchParams.get("stage") ?? "all";
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    let rows = await store.listTokens();
    if (stage === "bonding") rows = rows.filter((t) => t.stage !== "graduated");
    else if (stage === "graduated") rows = rows.filter((t) => t.stage === "graduated");
    if (q) rows = rows.filter((t) => [t.mint, t.name, t.symbol, t.creator].some((x) => x.toLowerCase().includes(q)));
    // Compare exact quote base units through the current reference rate. Unrated assets
    // use chronology, since their raw volumes cannot be compared across quote mints.
    const newest = (a: TokenRow, b: TokenRow) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0) || b.updatedAt - a.updatedAt || a.mint.localeCompare(b.mint);
    const usdVolume = (t: TokenRow): { numerator: bigint; denominator: bigint } | null => {
      const rate = quoteUsdRate(t.quoteMint, price?.solUsd ?? null).value;
      if (rate === null) return null;
      // Preserve the reference number's decimal representation, including exponent notation;
      // only the external rate is a number, never the indexed integer volume.
      const [mantissa, exponent = "0"] = rate.toString().toLowerCase().split("e");
      const [whole, fraction = ""] = mantissa.split(".");
      const scale = fraction.length - Number(exponent) + (t.quoteDecimals ?? 9);
      const numerator = BigInt(t.volume24hLamports) * BigInt(whole + fraction);
      return scale >= 0 ? { numerator, denominator: 10n ** BigInt(scale) }
        : { numerator: numerator * 10n ** BigInt(-scale), denominator: 1n };
    };
    const byVolume = (a: TokenRow, b: TokenRow) => {
      const ua = usdVolume(a), ub = usdVolume(b);
      if (ua && ub) {
        const left = ua.numerator * ub.denominator, right = ub.numerator * ua.denominator;
        return left > right ? -1 : left < right ? 1 : newest(a, b);
      }
      return ua ? -1 : ub ? 1 : newest(a, b);
    };
    rows.sort(sort === "newest" ? newest : byVolume);
    const cursor = url.searchParams.get("cursor");
    let start = 0;
    if (cursor) { const i = rows.findIndex((t) => t.mint === cursor); start = i >= 0 ? i + 1 : 0; }
    const page = rows.slice(start, start + limit);
    const next = start + limit < rows.length ? page[page.length - 1]?.mint ?? null : null;
    return send(200, await envelope(store, opts, { tokens: page.map((t) => tokenView(t, price?.solUsd ?? null)), total: rows.length, nextCursor: next, sort, stage, volumeRanking: { basis: "quote-usd-v1", unrated: "newest" } }), { "cache-control": "public, max-age=5" });
  }
  const mint = parts[2];
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return send(404, { error: "no such token" });
  const t = await store.getToken(mint);
  if (!t) return send(404, { error: "no such token" });
  if (parts.length === 3) return send(200, await envelope(store, opts, tokenView(t, price?.solUsd ?? null)), { "cache-control": "public, max-age=5" });
  if (parts.length === 4 && parts[3] === "trades") {
    const cursor = url.searchParams.get("cursor");
    // the cursor is the full trade key, so two transactions in one slot with the same ordinal page apart
    let before: { slot: number; idx: number; signature: string } | null = null;
    if (cursor) { const [s, i, sig] = cursor.split(":"); if (Number.isFinite(Number(s)) && Number.isFinite(Number(i)) && sig) before = { slot: Number(s), idx: Number(i), signature: sig }; }
    const pools = [t.dbcPool, ...(t.dammPool ? [t.dammPool] : [])];
    const trades = await store.listTradesByPools(pools, limit + 1, before);
    const page = trades.slice(0, limit);
    const last = page[page.length - 1];
    return send(200, await envelope(store, opts, { trades: page.map((x) => tradeView(withQuote(x, t))), nextCursor: trades.length > limit && last ? `${last.slot}:${last.idx}:${last.signature}` : null }), { "cache-control": "public, max-age=5" });
  }
  return send(404, { error: "not found" });
}

/** Every tail, server-side: the vault's tail token with its source coins (any launchpad's config: each stream
 *  carries the source mint the indexer resolved), raise, fees in (lifetime from the vault's accounting, the
 *  last 24 hours as the exact sum of indexed harvest events), bids placed, refunded, resting and filled, tail
 *  tokens burned, and when the unwind opens. A field that cannot be computed is null, never zero. */
export async function tailsRollup(store: Store, fi: FeeIndex | null, q: { limit: number; offset: number; source: string | null }, nowMs = Date.now()) {
  const tokens = await tokenIdentities(store);
  const streams = await store.listAllStreams();
  const byVault = new Map<string, typeof streams>();
  for (const s of streams) byVault.set(s.vault, [...(byVault.get(s.vault) ?? []), s]);
  let vaults = await store.listVaults();
  const kind = (d: any) => (d?.kind && typeof d.kind === "object" ? Object.keys(d.kind)[0] : String(d?.kind ?? ""));
  const sourceMint = (s: { data: any }) => (s.data?.sourceMint ? String(s.data.sourceMint) : tokens.byPool.get(String(s.data?.pool ?? ""))?.mint ?? fi?.lookup(String(s.data?.pool ?? ""))?.mint ?? null);
  if (q.source) vaults = vaults.filter((v) => (byVault.get(v.vault) ?? []).some((s) => !s.data?.isOwn && sourceMint(s) === q.source));
  const total = vaults.length;
  vaults = vaults.sort((a, b) => b.updatedAt - a.updatedAt || a.vault.localeCompare(b.vault)).slice(q.offset, q.offset + q.limit);
  // outside coins (not in the main index) get their name and logo from the Fee Index, read now if it lacks them
  if (fi) {
    const outside = vaults.flatMap((v) => (byVault.get(v.vault) ?? []).filter((s) => !s.data?.isOwn).map(sourceMint)).filter((m): m is string => !!m && !tokens.byMint.has(m));
    if (outside.length) await fi.ensureIdentity(outside, 2_500);
  }
  const since = Math.floor(nowMs / 1000) - 86_400;
  const harvests = await store.listEventsSince(["harvested", "oneTimeHarvested"], since);
  const rows = await Promise.all(vaults.map(async (v) => {
    const d = v.data ?? {}, acc = d.accounting ?? {};
    const status = Object.keys(d.status ?? {})[0] ?? "open";
    const mine = byVault.get(v.vault) ?? [];
    const own = mine.find((s) => s.data?.isOwn && kind(s.data) === "dbcCreatorRights");
    const st = await store.getToken(String(d.stMint));
    const stIdentity = tokens.byMint.get(String(d.stMint)) ?? null;
    const bonding = st ? { quoteRaisedLamports: st.quoteRaisedLamports, targetLamports: st.targetLamports, progressBps: st.progressBps, migrationStage: st.stage } : null;
    const ladder = d.live?.ladder ?? null;
    const outstanding = Number(d.routing?.outstandingOrders ?? 0);
    // resting principal is known only from a complete read: the ladder ok, no unknown bins or unread orders,
    // and as many order records read as the vault says are outstanding; anything else is unknown, not zero
    const ladderComplete = ladder?.status === "ok" && Number(ladder.unknownBins ?? 0) === 0 && Number(ladder.missingOrders ?? 0) === 0 && Array.isArray(ladder.orders) && ladder.orders.length === outstanding && (ladder.records === undefined || Number(ladder.records) === outstanding);
    const resting: string | null = outstanding === 0 ? "0" : ladderComplete ? String(ladder.restingLamports) : null;
    const placed = BigInt(String(acc.routedGross ?? 0)), refunded = BigInt(String(acc.refundedPrincipal ?? 0));
    return {
      vault: v.vault, status, stMint: String(d.stMint), name: stIdentity?.name ?? null, symbol: stIdentity?.symbol ?? null, imageUrl: stIdentity?.imageUrl ?? null, decimals: st?.decimals ?? null,
      sources: mine.filter((s) => !s.data?.isOwn).map((s) => { const mint = sourceMint(s); const t = mint ? tokens.byMint.get(mint) : null; const f = mint && !t && fi ? fi.lookup(mint) : null;
        return { stream: s.stream, kind: kind(s.data), pool: String(s.data?.pool ?? ""), mint, name: t?.name ?? f?.name ?? null, symbol: t?.symbol ?? f?.symbol ?? null, imageUrl: t?.imageUrl ?? f?.imageUrl ?? null }; }),
      raise: bonding ? { raisedLamports: String(bonding.quoteRaisedLamports ?? "0"), targetLamports: String(bonding.targetLamports ?? "0"), progressBps: bonding.progressBps === null ? null : Number(bonding.progressBps), stage: bonding.migrationStage ?? null } : null,
      feesIn: { lifetimeLamports: String(acc.harvestedGross ?? "0"), last24hLamports: harvests.filter((e) => e.vault === v.vault).reduce((n, e) => n + BigInt(String((e.data as any)?.gross ?? 0)), 0n).toString() },
      bids: { placedLamports: placed.toString(), refundedLamports: refunded.toString(), restingLamports: resting, filledLamports: resting === null ? null : (placed - refunded - BigInt(resting)).toString() },
      burnedStRaw: String(acc.burnedSt ?? "0"),
      unwindOpensAtSec: own ? Number(own.data.depositTs) + 30 * 86_400 : null,
    };
  }));
  return { total, offset: q.offset, limit: q.limit, tails: rows };
}

/** The Fee Index routes: public and read-only, any origin, rate-limited like everything else. */
async function feeRoutes(fi: FeeIndex | null, cluster: string, url: URL, limit: number, send: (code: number, body: unknown, extra?: Record<string, string>) => void) {
  const any = { "access-control-allow-origin": "*", "cache-control": "public, max-age=30" };
  if (!fi) return send(503, { error: "fee index not enabled on this server" }, any);
  const status = fi.status();
  const head = { schemaVersion: 1, cluster, generatedAtMs: Date.now(), coverage: status };
  if (url.pathname === "/api/fees/status") return send(200, head, any);
  if (url.pathname === "/api/fees/launchpads") { const s = fi.db.meta("summary"); return send(200, { ...head, ...(s ? JSON.parse(s) : { launchpads: [], ourConfigs: [] }) }, any); }
  if (url.pathname === "/api/fees/coins") {
    const sort = url.searchParams.get("sort") ?? "day";
    if (!["day", "claimable", "lifetime", "avg"].includes(sort)) return send(400, { error: "sort must be day, claimable, lifetime or avg" }, any);
    const stage = url.searchParams.get("stage") ?? "all";
    if (!["all", "bonding", "graduated"].includes(stage)) return send(400, { error: "stage must be all, bonding or graduated" }, any);
    const creator = url.searchParams.get("creator");
    if (creator && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(creator)) return send(400, { error: "bad creator" }, any);
    const offset = Math.max(0, Math.min(100_000, Number(url.searchParams.get("offset") ?? 0) || 0));
    const search = (url.searchParams.get("q") ?? "").trim().slice(0, 64) || null;
    const n = Math.min(200, limit);
    const q = { sort: sort as any, stage, eligible: url.searchParams.get("eligible") === "1", creator, search, limit: n, offset };
    let coins = fi.coins(q);
    // names and logos the index has not read yet are read now (bounded); the page shows whatever arrived
    const lacking = coins.filter((c: { name: string | null; imageUrl: string | null }) => !c.name || !c.imageUrl).map((c: { mint: string }) => c.mint);
    if (lacking.length) { await fi.ensureIdentity(lacking, 2_500); coins = fi.coins(q); }
    return send(200, { ...head, basis: ESTIMATE_BASIS, coins, offset, limit: n }, any);
  }
  const m = url.pathname.match(/^\/api\/fees\/coins\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (m) {
    let c = fi.coin(m[1]);
    if (c && (!c.name || !c.imageUrl)) { await fi.ensureIdentity([c.mint], 5_000); c = fi.coin(m[1]); }
    return c ? send(200, { ...head, basis: ESTIMATE_BASIS, coin: c }, any) : send(404, { ...head, error: "not in the fee index (not SOL-paired, or no creator fee yet)" }, any);
  }
  return send(404, { error: "not found" }, any);
}

export async function startApi(store: Store, opts: ApiOptions): Promise<http.Server> {
  await refuseIfTaken(opts.host, opts.port);
  const buckets = new Buckets(opts.ratePerMinute, Math.max(10, Math.ceil(opts.ratePerMinute / 2)));
  const allowOrigin = (req: http.IncomingMessage): string | null => {
    const o = req.headers.origin;
    if (!o) return null;
    return opts.origins.includes(o) ? o : null;
  };
  const server = http.createServer(async (req, res) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://localhost"); } catch {
      res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "bad URL" })); return;
    }
    const origin = allowOrigin(req);
    const cors: Record<string, string> = origin ? { "access-control-allow-origin": origin, "vary": "Origin", "access-control-allow-methods": "GET", "access-control-max-age": "600" } : {};
    const send = (code: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "public, max-age=10", "x-content-type-options": "nosniff", ...cors, ...extra });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "OPTIONS") { res.writeHead(204, url.pathname === "/api/feed" || url.pathname.startsWith("/api/fees") ? { "access-control-allow-origin": "*", "access-control-allow-methods": "GET", "access-control-max-age": "600" } : cors); return res.end(); }
      if (req.method !== "GET") return send(405, { error: "method not allowed" }, { allow: "GET" });
      const remote = req.socket.remoteAddress ?? "";
      const fromProxy = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      const forwarded = fromProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
      const client = forwarded || remote;
      if (!buckets.take(client)) return send(429, { error: "rate limited" }, { "retry-after": "10" });
      const requestedLimit = url.searchParams.get("limit");
      if (requestedLimit !== null && (!/^\d+$/.test(requestedLimit) || !Number.isSafeInteger(Number(requestedLimit)) || Number(requestedLimit) < 1)) {
        return send(400, { error: "limit must be a positive integer" }, url.pathname === "/api/feed" ? { "access-control-allow-origin": "*" } : {});
      }
      const limit = Math.min(1000, Number(requestedLimit ?? 200));
      if (url.pathname === "/api/health") return send(200, { ok: true, service: "cometail-indexer", time: Date.now() });
      if (url.pathname === "/api/sky") { const tokens = await tokenIdentities(store); return send(200, { streams: (await store.listSky(limit)).map((r) => ({ ...r, token: tokens.byMint.get(r.baseMint) ?? null })) }); }
      if (url.pathname === "/api/vaults") { const tokens = await tokenIdentities(store); return send(200, { vaults: (await store.listVaults()).map((v) => ({ ...v, stToken: tokens.byMint.get(String(v.data?.stMint ?? "")) ?? null })) }); }
      const m = url.pathname.match(/^\/api\/vaults\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (m) {
        const vault = await store.getVault(m[1]);
        if (!vault) return send(404, { error: "no such vault" });
        const tokens = await tokenIdentities(store);
        // each stream names the token behind it: the DBC pool for rights, the DAMM pool for positions
        const streams = (await store.listStreams(m[1])).map((s) => ({ ...s, token: tokens.byPool.get(String(s.data?.pool ?? "")) ?? null }));
        return send(200, { ...vault, stToken: tokens.byMint.get(String(vault.data?.stMint ?? "")) ?? null, streams, events: await store.listEvents(m[1], limit), trades: await store.listTrades(m[1], limit) });
      }
      if (url.pathname === "/api/events") return send(200, { events: await store.listEvents(url.searchParams.get("vault"), limit) });
      if (url.pathname === "/api/feed") {
        // the feed is public: any origin may replay it (the SDK runs anywhere)
        const since = url.searchParams.get("since");
        const cursor = since ? parseCursor(since) : null;
        if (since && !cursor) return send(400, { error: "bad cursor" }, { "access-control-allow-origin": "*" });
        const types = parseTypes(url.searchParams.get("types"));
        if (types === "invalid") return send(400, { error: "unknown type", types: [...FEED_TYPES, "fees"] }, { "access-control-allow-origin": "*" });
        const r = await replay(store, opts.cluster ?? "devnet", cursor, Math.min(500, limit), types);
        return send(r.status, r.body, { "access-control-allow-origin": "*", "cache-control": "no-store" });
      }
      if (url.pathname === "/api/tokens" || url.pathname.startsWith("/api/tokens/")) return await tokenRoutes(store, opts, url, send);
      if (url.pathname.startsWith("/api/fees")) return await feeRoutes(opts.feeIndex ?? null, opts.cluster ?? "devnet", url, limit, send);
      if (url.pathname === "/api/tails") {
        const source = url.searchParams.get("source");
        if (source && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(source)) return send(400, { error: "bad source mint" });
        const offset = Math.max(0, Math.min(100_000, Number(url.searchParams.get("offset") ?? 0) || 0));
        return send(200, { schemaVersion: 1, cluster: opts.cluster ?? "devnet", generatedAtMs: Date.now(), ...(await tailsRollup(store, opts.feeIndex ?? null, { limit: Math.min(100, limit), offset, source })) }, { "cache-control": "public, max-age=15" });
      }
      if (url.pathname === "/api/burn") {
        if (!opts.burnView) return send(503, { error: "burn view not enabled on this server" }, { "access-control-allow-origin": "*" });
        try { return send(200, await opts.burnView(), { "access-control-allow-origin": "*", "cache-control": "public, max-age=15" }); }
        catch (e) { log("burn view failed", { error: String((e as Error).message ?? e) }); return send(503, { error: "burn view unavailable" }, { "access-control-allow-origin": "*" }); }
      }
      if (url.pathname === "/api/burn/burns" || url.pathname === "/api/burn/splits") {
        const any = { "access-control-allow-origin": "*", "cache-control": "public, max-age=15" };
        if (!opts.burnHistory) return send(503, { error: "burn view not enabled on this server" }, any);
        const page = await opts.burnHistory(url.pathname.endsWith("burns") ? "burns" : "splits", url.searchParams.get("before"), Math.min(100, limit));
        return page === "invalid" ? send(400, { error: "bad cursor" }, any) : send(200, { schemaVersion: 1, cluster: opts.cluster ?? "devnet", generatedAtMs: Date.now(), ...(page as object) }, any);
      }
      if (url.pathname === "/api/prices") { const p = await solUsd(); return p ? send(200, p, { "cache-control": "public, max-age=30" }) : send(503, { error: "price unavailable" }); }
      if (url.pathname === "/api/metrics") {
        // the whole store is read for this document: computed at most once per 30 s, shared by every caller
        if (!metricsMemo || Date.now() - metricsMemo.at > 30_000) metricsMemo = { at: Date.now(), value: await metrics(store, new Set(opts.demoActors ?? []), new Set(opts.plainConfigs ?? [])) };
        return send(200, metricsMemo.value, { "cache-control": "public, max-age=30" });
      }
      send(404, { error: "not found" });
    } catch (e) {
      log("api error", { path: url.pathname, error: String((e as Error).message ?? e) });
      send(500, { error: "internal" });
    }
  });
  attachFeed(server, store, { cluster: opts.cluster ?? "devnet", maxPerClient: 5, coverage: async () => {
    const cursors = await store.listPoolCursors();
    const pending = cursors.filter((c) => c.cursor.status !== "ok").length;
    const scanned = await store.getMeta("tokens_scanned_at");
    return { status: pending ? "partial" : scanned ? "complete" : "stale", pendingPools: pending, lastSuccessfulAtMs: scanned ? Number(scanned) : null };
  } });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => { server.off("error", reject); resolve(); });
  });
  log("api listening", { host: opts.host, port: opts.port, origins: opts.origins, ratePerMinute: opts.ratePerMinute });
  return server;
}
