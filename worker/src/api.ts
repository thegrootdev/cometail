// The site's read API, served next to the indexer. JSON only, GET only, no writes.
//   GET /api/sky?limit=200          the Sky scan, by claimable backlog
//   GET /api/vaults                 every vault snapshot
//   GET /api/vaults/:vault          one vault with its streams and latest events
//   GET /api/events?vault=&limit=   events, newest first
//   GET /api/health
//   GET /api/metrics                the submission metrics, independent actors apart from the demo set
// It binds to the loopback interface and expects a reverse proxy in front for TLS. CORS is
// limited to the configured origins, and each client address gets a token bucket; the
// client address is taken from X-Forwarded-For only when the connection comes from loopback.
import http from "http";
import net from "net";
import { Store } from "./store";
import { log } from "./tx";

export interface ApiOptions { host: string; port: number; origins: string[]; ratePerMinute: number; demoActors?: string[]; plainConfigs?: string[] }

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
  const buyerSets = { independent: new Set<string>(), demo: new Set<string>(), unattributed: new Set<string>() };
  const buyVolume = triple(); let buys = 0, sells = 0;
  for (const t of trades) {
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
      "buyers are the distinct signers of stream-token purchases on the vaults' graduated pools (cp-amm swap / swap2 paired with EvtSwap2), classified by the signer wallet; a purchase known only by its fee payer is unattributed; sells are counted, not attributed",
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
    bidDepthLamports: str(depth),
    fillsAndBurns: { settledWithBurn: fills, burnedSt: str(burned) },
    refundedPrincipalLamports: str(refunded),
  };
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
      if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
      if (req.method !== "GET") return send(405, { error: "method not allowed" }, { allow: "GET" });
      const remote = req.socket.remoteAddress ?? "";
      const fromProxy = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      const forwarded = fromProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
      const client = forwarded || remote;
      if (!buckets.take(client)) return send(429, { error: "rate limited" }, { "retry-after": "10" });
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
      if (url.pathname === "/api/health") return send(200, { ok: true, service: "cometail-indexer", time: Date.now() });
      if (url.pathname === "/api/sky") return send(200, { streams: await store.listSky(limit) });
      if (url.pathname === "/api/vaults") return send(200, { vaults: await store.listVaults() });
      const m = url.pathname.match(/^\/api\/vaults\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (m) {
        const vault = await store.getVault(m[1]);
        if (!vault) return send(404, { error: "no such vault" });
        return send(200, { ...vault, streams: await store.listStreams(m[1]), events: await store.listEvents(m[1], limit), trades: await store.listTrades(m[1], limit) });
      }
      if (url.pathname === "/api/events") return send(200, { events: await store.listEvents(url.searchParams.get("vault"), limit) });
      if (url.pathname === "/api/metrics") return send(200, await metrics(store, new Set(opts.demoActors ?? []), new Set(opts.plainConfigs ?? [])), { "cache-control": "public, max-age=60" });
      send(404, { error: "not found" });
    } catch (e) {
      log("api error", { path: url.pathname, error: String((e as Error).message ?? e) });
      send(500, { error: "internal" });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => { server.off("error", reject); resolve(); });
  });
  log("api listening", { host: opts.host, port: opts.port, origins: opts.origins, ratePerMinute: opts.ratePerMinute });
  return server;
}
