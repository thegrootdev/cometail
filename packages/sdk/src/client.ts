import type { Address, Envelope, EstimateLabel, Evidence, FeedEvent, FeedReplay, Health, Metrics, Prices, RequestOptions, SkyStream, Stream, Token, TokenList, TokenQuery, Trade, Vault, VaultDetail, VaultEvent, VaultTrade, FeedType, FeeCoin, FeeEnvelope, Launchpad, OurConfig, Tail, BurnView, BurnRow, SplitRow } from "./types.js";
import { array, compareCursors, decodeEnvelope, decodeFrame, isFeedEvent, evidence, number, object, parseCursor, ProtocolError, text, tradeQuote } from "./protocol.js";
import { FeedSubscription } from "./feed.js";
import type { FeedOptions } from "./feed.js";
export interface ClientOptions {
  /** Origin only, e.g. https://api.cometail.fun. No key or wallet is needed. */
  baseUrl?: string; fetch?: typeof globalThis.fetch; timeoutMs?: number; maxResponseChars?: number;
}
export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryAfter: string | null, public readonly body: unknown) { super(message); this.name = "ApiError"; }
}
const label = (path: string, basis: string): EstimateLabel => ({ path, basis, source: "estimate" });
function row<T>(value: unknown, estimates: EstimateLabel[] = []): T {
  const r = object(value); return { ...r, ...evidence(r, estimates) } as T;
}
function token(value: unknown): Token {
  const r = object(value), id = object(r.identity), market = object(r.market);
  text(id.mint); number(id.decimals); text(market.totalSupplyRaw);
  object(r.volume24h); object(r.holders); object(r.bonding);
  const labels: EstimateLabel[] = [];
  if (typeof market.fdvUsd === "string") labels.push(label("market.fdvUsd", "Derived fully diluted value from total supply, indexed price and the response's quote-to-USD reference; not circulating market cap."));
  if (market.liquidityBasis === "damm-quote-x2") labels.push(label("market.liquidityLamports", "Graduated pool quote side multiplied by two; a liquidity estimate."));
  return row<Token>(r, labels);
}
function event<T>(value: unknown): T { const r = object(value); text(r.signature); number(r.slot); return row<T>(r); }
function query(values: Record<string, string | number | undefined>, maxLimit?: number): string {
  if (values.limit !== undefined && (typeof values.limit !== "number" || !Number.isInteger(values.limit) || values.limit < 1 || values.limit > (maxLimit ?? 1000))) throw new RangeError(`limit must be an integer from 1 to ${maxLimit ?? 1000}`);
  const q = new URLSearchParams(); for (const [k, v] of Object.entries(values)) if (v !== undefined) q.set(k, String(v));
  return q.size ? `?${q}` : "";
}
function address(value: Address): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw new TypeError("Expected a base58 address");
  return encodeURIComponent(value);
}
export class CometailClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxChars: number;
  constructor(options: ClientOptions = {}) {
    const url = new URL(options.baseUrl ?? "https://api.cometail.fun");
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new TypeError("baseUrl must be an HTTP(S) origin without credentials");
    this.baseUrl = url.origin; this.fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!this.fetcher) throw new TypeError("Supply a fetch implementation");
    this.timeoutMs = options.timeoutMs ?? 15_000; this.maxChars = options.maxResponseChars ?? 8_000_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || !Number.isFinite(this.maxChars) || this.maxChars <= 0) throw new RangeError("Timeout and response limit must be positive");
  }
  private async get(path: string, options: RequestOptions = {}): Promise<unknown> {
    const controller = new AbortController(), abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("API request timed out")), this.timeoutMs);
    try {
      const response = await this.fetcher(this.baseUrl + path, { method: "GET", headers: { accept: "application/json" }, signal: controller.signal });
      const body = await response.text();
      if (body.length > this.maxChars) throw new ProtocolError("API response exceeds configured limit");
      let data: unknown;
      try { data = JSON.parse(body); } catch {
        if (!response.ok) throw new ApiError(response.status, `API request failed (${response.status})`, response.headers.get("retry-after"), null);
        throw new ProtocolError("API returned invalid JSON");
      }
      if (!response.ok) throw new ApiError(response.status, typeof data === "object" && data && "error" in data && typeof data.error === "string" ? data.error : `API request failed (${response.status})`, response.headers.get("retry-after"), data);
      return data;
    } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
  }
  async tokens(q: TokenQuery = {}, options?: RequestOptions): Promise<Envelope<TokenList>> {
    const r = decodeEnvelope(await this.get("/api/tokens" + query({ ...q }, 100), options)), d = object(r.data);
    number(d.total); if (d.nextCursor !== null) text(d.nextCursor);
    return { ...r, ...evidence(r), data: { ...d, tokens: array(d.tokens).map(token) } } as Envelope<TokenList>;
  }
  async token(mint: Address, options?: RequestOptions): Promise<Envelope<Token>> {
    const r = decodeEnvelope(await this.get(`/api/tokens/${address(mint)}`, options));
    return { ...r, ...evidence(r), data: token(r.data) } as Envelope<Token>;
  }
  async trades(mint: Address, q: { cursor?: string; limit?: number } = {}, options?: RequestOptions): Promise<Envelope<{ trades: Trade[]; nextCursor: string | null }>> {
    const r = decodeEnvelope(await this.get(`/api/tokens/${address(mint)}/trades` + query(q, 100), options)), d = object(r.data);
    if (d.nextCursor !== null) text(d.nextCursor);
    return { ...r, ...evidence(r), data: { ...d, trades: array(d.trades).map(v => { const t = event<Trade>(v); tradeQuote(t as unknown as Record<string, unknown>); return t; }) } } as Envelope<{ trades: Trade[]; nextCursor: string | null }>;
  }
  async sky(q: { limit?: number } = {}, options?: RequestOptions): Promise<{ streams: SkyStream[] } & Evidence> {
    const r = object(await this.get("/api/sky" + query(q), options));
    return { ...r, ...evidence(r), streams: array(r.streams).map(v => {
      const s = object(v); text(s.baseMint); text(s.claimableLamports);
      return row<SkyStream>(s, [label("realizedEstimateLamports", "Aggregate curve creator fee accrual less claimable fees; rounding may differ from claims; not graduated-pool income.")]);
    }) };
  }
  async vaults(options?: RequestOptions): Promise<{ vaults: Vault[] } & Evidence> {
    const r = object(await this.get("/api/vaults", options));
    return { ...r, ...evidence(r), vaults: array(r.vaults).map(v => { const d = object(v); text(d.vault); object(d.data); return row<Vault>(d); }) };
  }
  async vault(key: Address, q: { limit?: number } = {}, options?: RequestOptions): Promise<VaultDetail> {
    const r = object(await this.get(`/api/vaults/${address(key)}` + query(q), options)); text(r.vault); object(r.data);
    return { ...row<Vault>(r), streams: array(r.streams).map(v => row<Stream>(v)), events: array(r.events).map(v => event<VaultEvent>(v)), trades: array(r.trades).map(v => event<VaultTrade>(v)) };
  }
  async events(q: { vault?: Address; limit?: number } = {}, options?: RequestOptions): Promise<{ events: VaultEvent[] } & Evidence> {
    if (q.vault) address(q.vault);
    const r = object(await this.get("/api/events" + query(q), options));
    return { ...r, ...evidence(r), events: array(r.events).map(v => event<VaultEvent>(v)) };
  }
  async metrics(options?: RequestOptions): Promise<Metrics> {
    const r = object(await this.get("/api/metrics", options)); number(r.generatedAt); object(r.plainLaunches);
    return row<Metrics>(r, [label("plainLaunches.volumeEstimateLamports", "Flat 1% curve fee booked net of the 20% protocol share: net trading fee × 125; subject to rounding. The response notes and incomplete flag apply.")]);
  }
  async prices(options?: RequestOptions): Promise<Prices> {
    const r = object(await this.get("/api/prices", options)); number(r.solUsd); text(r.source); number(r.at); return row<Prices>(r);
  }
  async health(options?: RequestOptions): Promise<Health> { const r = object(await this.get("/api/health", options)); return row<Health>(r); }
  /** With `types`, the server scans `limit` rows and returns the matching ones; `nextCursor` may then name a
   *  scanned row past the last returned event (a filtered page can be empty and still continue). */
  async replay(q: { since?: string; limit?: number; types?: readonly FeedType[] } = {}, options?: RequestOptions): Promise<FeedReplay> {
    if (q.since !== undefined) parseCursor(q.since);
    const filtered = !!q.types?.length;
    const r = object(await this.get("/api/feed" + query({ since: q.since, limit: q.limit, types: filtered ? q.types!.join(",") : undefined }, 500), options));
    if (r.schemaVersion !== 1 || r.type !== "replay") throw new ProtocolError("Unsupported replay envelope");
    text(r.cluster); number(r.generatedAtMs);
    let previous = q.since;
    const events = array(r.events).map(v => {
      const frame = decodeFrame(v);
      if (!isFeedEvent(frame)) throw new ProtocolError("Control frame in replay events");
      if (previous !== undefined && compareCursors(frame.cursor, previous) <= 0) throw new ProtocolError("Replay is not strictly increasing after since");
      previous = frame.cursor; return frame;
    });
    const next = r.nextCursor === null ? null : text(r.nextCursor);
    if (next !== null && !filtered && (events.length === 0 || compareCursors(next, events[events.length - 1]!.cursor) !== 0)) throw new ProtocolError("nextCursor must acknowledge the last event in this replay page");
    if (next !== null && filtered) {
      // filtered pages may be empty or stop short of the scanned rows: the cursor must still parse and advance
      parseCursor(next);
      if (q.since !== undefined && compareCursors(next, q.since) <= 0) throw new ProtocolError("A filtered nextCursor must advance beyond since");
      if (events.length && compareCursors(next, events[events.length - 1]!.cursor) < 0) throw new ProtocolError("nextCursor must not precede the last event in this replay page");
    }
    if (filtered) for (const e of events) if (!q.types!.includes(e.type)) throw new ProtocolError("Replay returned a type that was not asked for");
    return { schemaVersion: 1, type: "replay", cluster: text(r.cluster), generatedAtMs: number(r.generatedAtMs), events, nextCursor: next, ...(filtered ? { types: [...q.types!] } : {}) };
  }
  /** One page at a time; abort cancels an active request. Does not claim retention is complete. */
  async *replayAll(since?: string, options?: RequestOptions, types?: readonly FeedType[]): AsyncGenerator<FeedEvent> {
    let cursor = since;
    do {
      const page = await this.replay({ since: cursor, limit: 500, types }, options);
      for (const event of page.events) yield event;
      if (page.nextCursor === null) return;
      if (cursor !== undefined && compareCursors(page.nextCursor, cursor) <= 0) throw new ProtocolError("Replay did not advance");
      cursor = page.nextCursor;
    } while (true);
  }
  /** The Fee Index: SOL-paired DBC coins of every launchpad, ranked by creator income. */
  async feeCoins(q: { sort?: "day" | "claimable" | "lifetime" | "avg"; stage?: "all" | "bonding" | "graduated"; eligible?: boolean; creator?: Address; q?: string; limit?: number; offset?: number } = {}, options?: RequestOptions): Promise<FeeEnvelope & { basis: Record<string, string>; coins: FeeCoin[]; offset: number; limit: number }> {
    const r = object(await this.get("/api/fees/coins" + query({ sort: q.sort, stage: q.stage, eligible: q.eligible ? 1 : undefined, creator: q.creator, q: q.q, limit: q.limit, offset: q.offset }, 200), options));
    array(r.coins); object(r.coverage); return r as unknown as FeeEnvelope & { basis: Record<string, string>; coins: FeeCoin[]; offset: number; limit: number };
  }
  async feeCoin(mint: Address, options?: RequestOptions): Promise<FeeEnvelope & { basis: Record<string, string>; coin: FeeCoin }> {
    const r = object(await this.get(`/api/fees/coins/${address(mint)}`, options)); object(r.coin); return r as unknown as FeeEnvelope & { basis: Record<string, string>; coin: FeeCoin };
  }
  /** Every tail with its source coins, raise, fees in, bids placed/refunded/resting/filled, burns and unwind date; `source` filters by a source coin's mint. */
  async tails(q: { limit?: number; offset?: number; source?: Address } = {}, options?: RequestOptions): Promise<{ schemaVersion: 1; cluster: string; generatedAtMs: number; total: number; offset: number; limit: number; tails: Tail[] }> {
    const r = object(await this.get("/api/tails" + query({ limit: q.limit, offset: q.offset, source: q.source }, 100), options)); array(r.tails); number(r.total);
    return r as unknown as { schemaVersion: 1; cluster: string; generatedAtMs: number; total: number; offset: number; limit: number; tails: Tail[] };
  }
  /** Launchpads (fee claimers) ranked by what their creators earn, and the protocol's own configs. */
  /** The $COMETAIL buyback and burn: the program's counters, the reserve, and the newest 50 burns and splits with signatures. */
  async burn(options?: RequestOptions): Promise<BurnView> {
    const r = object(await this.get("/api/burn", options));
    if (!["live", "not-set-up", "unavailable"].includes(String(r.status))) throw new Error("unexpected burn status");
    return r as unknown as BurnView;
  }

  /** Every burn or every split, newest first, 1 to 100 per page; pass the previous page's `nextCursor`. */
  async burnHistory(kind: "burns" | "splits", q: { before?: string | null; limit?: number } = {}, options?: RequestOptions): Promise<{ kind: "burns" | "splits"; total: number; items: (BurnRow | SplitRow)[]; nextCursor: string | null; coverage: BurnView["coverage"] }> {
    const r = object(await this.get(`/api/burn/${kind}` + query({ before: q.before ?? undefined, limit: q.limit }, 100), options)); array(r.items); number(r.total);
    return r as unknown as { kind: "burns" | "splits"; total: number; items: (BurnRow | SplitRow)[]; nextCursor: string | null; coverage: BurnView["coverage"] };
  }

  async launchpads(options?: RequestOptions): Promise<FeeEnvelope & { rankedBy: "last24h" | "lifetime"; historySinceMs: number; basis: Record<string, string>; launchpads: Launchpad[]; ourConfigs: OurConfig[] }> {
    const r = object(await this.get("/api/fees/launchpads", options)); array(r.launchpads); return r as unknown as FeeEnvelope & { rankedBy: "last24h" | "lifetime"; historySinceMs: number; basis: Record<string, string>; launchpads: Launchpad[]; ourConfigs: OurConfig[] };
  }
  feed(options: FeedOptions): FeedSubscription { return new FeedSubscription(this.baseUrl, options); }
}
