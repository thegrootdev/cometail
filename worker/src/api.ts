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
import http from "http";
import net from "net";
import { Store, TokenRow, TradeRow } from "./store";
import { attachFeed, parseCursor, replay } from "./feed";
import { log } from "./tx";

export interface ApiOptions { host: string; port: number; origins: string[]; ratePerMinute: number; demoActors?: string[]; plainConfigs?: string[]; cluster?: string }

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
  for (const r of sky) if ((r.kind ?? "curve") === "curve" && plainConfigs.has(r.config)) {
    // a program-held creator is a vault PDA: the launch belongs to that vault's depositor, or is
    // unattributed until the vault record exists; a wallet creator classifies by itself
    // without a vault record only a wallet-held creator is a resolved owner; program or unknown custody is unattributed
    const c: Cls = r.vault ? ofVault(r.vault) : r.custody === "wallet" ? cls(r.creator) : "unattributed";
    launches[c]++; launchFees[c] += BigInt(r.tradingFeeLamports);
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
    plainLaunches: { count: launches, tradingFeeLamports: str(launchFees), volumeEstimateLamports: volume(launchFees) },
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
function tradeView(t: TradeRow) {
  return { id: `${t.signature}:${t.idx}:${t.pool}`, signature: t.signature, ordinal: t.idx, slot: t.slot, blockTimeSec: t.blockTime, pool: t.pool, venue: t.venue ?? null, side: t.buy ? "buy" : "sell", baseAmountRaw: t.baseAmountRaw ?? null, quoteAmountLamports: t.quoteAmountLamports ?? null, executionPriceSol: t.executionPriceSol ?? null, executionPriceQuote: t.executionPriceQuote ?? t.executionPriceSol ?? null, quoteMint: t.quoteMint ?? WSOL, quoteDecimals: t.quoteDecimals ?? 9, trader: t.trader, traderKind: t.traderKind };
}
async function tokenRoutes(store: Store, opts: ApiOptions, url: URL, send: (code: number, body: unknown, extra?: Record<string, string>) => void) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const price = await solUsd();
  const parts = url.pathname.split("/").filter(Boolean); // api, tokens, [mint], [trades]
  if (parts.length === 2) {
    const sort = url.searchParams.get("sort") === "newest" ? "newest" : "volume24h";
    const stage = url.searchParams.get("stage") ?? "all";
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    let rows = await store.listTokens();
    if (stage === "bonding") rows = rows.filter((t) => t.stage !== "graduated");
    else if (stage === "graduated") rows = rows.filter((t) => t.stage === "graduated");
    if (q) rows = rows.filter((t) => [t.mint, t.name, t.symbol, t.creator].some((x) => x.toLowerCase().includes(q)));
    rows.sort((a, b) => sort === "newest" ? (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0) || b.updatedAt - a.updatedAt : (BigInt(b.volume24hLamports) > BigInt(a.volume24hLamports) ? 1 : BigInt(b.volume24hLamports) < BigInt(a.volume24hLamports) ? -1 : a.mint.localeCompare(b.mint)));
    const cursor = url.searchParams.get("cursor");
    let start = 0;
    if (cursor) { const i = rows.findIndex((t) => t.mint === cursor); start = i >= 0 ? i + 1 : 0; }
    const page = rows.slice(start, start + limit);
    const next = start + limit < rows.length ? page[page.length - 1]?.mint ?? null : null;
    return send(200, await envelope(store, opts, { tokens: page.map((t) => tokenView(t, price?.solUsd ?? null)), total: rows.length, nextCursor: next, sort, stage }), { "cache-control": "public, max-age=5" });
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
    return send(200, await envelope(store, opts, { trades: page.map(tradeView), nextCursor: trades.length > limit && last ? `${last.slot}:${last.idx}:${last.signature}` : null }), { "cache-control": "public, max-age=5" });
  }
  return send(404, { error: "not found" });
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
    const url = new URL(req.url ?? "/", "http://localhost");
    const origin = allowOrigin(req);
    const cors: Record<string, string> = origin ? { "access-control-allow-origin": origin, "vary": "Origin", "access-control-allow-methods": "GET", "access-control-max-age": "600" } : {};
    const send = (code: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "public, max-age=10", "x-content-type-options": "nosniff", ...cors, ...extra });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "OPTIONS") { res.writeHead(204, url.pathname === "/api/feed" ? { "access-control-allow-origin": "*", "access-control-allow-methods": "GET", "access-control-max-age": "600" } : cors); return res.end(); }
      if (req.method !== "GET") return send(405, { error: "method not allowed" }, { allow: "GET" });
      const remote = req.socket.remoteAddress ?? "";
      const fromProxy = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      const forwarded = fromProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
      const client = forwarded || remote;
      if (!buckets.take(client)) return send(429, { error: "rate limited" }, { "retry-after": "10" });
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
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
        const r = await replay(store, opts.cluster ?? "devnet", cursor, Math.min(500, limit));
        return send(r.status, r.body, { "access-control-allow-origin": "*", "cache-control": "no-store" });
      }
      if (url.pathname === "/api/tokens" || url.pathname.startsWith("/api/tokens/")) return tokenRoutes(store, opts, url, send);
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
    return { status: pending ? "pending" : "complete", pendingPools: pending, lastSuccessfulAtMs: scanned ? Number(scanned) : null };
  } });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => { server.off("error", reject); resolve(); });
  });
  log("api listening", { host: opts.host, port: opts.port, origins: opts.origins, ratePerMinute: opts.ratePerMinute });
  return server;
}
