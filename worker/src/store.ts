// Storage behind the indexer and the API: Postgres in production (DATABASE_URL=postgres://...),
// SQLite through node's built-in driver anywhere else (DATABASE_URL=sqlite:<file>). Both hold
// the same four tables plus the Sky scan; JSON columns carry the decoded accounts and events.
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

export interface EventRow { signature: string; idx: number; slot: number; blockTime: number | null; name: string; vault: string | null; data: any }
/** One swap on a vault's graduated stream-token pool (cp-amm EvtSwap2). `buy` is a purchase of the
 *  stream token with the quote; amounts are the pool's input and output in raw units. */
export interface TradeRow { signature: string; idx: number; slot: number; blockTime: number | null; pool: string; vault: string; trader: string; traderKind: "authority" | "feePayer"; buy: boolean; amountIn: string; amountOut: string;
  /** "curve" (DBC) or "damm" (DAMM v2); the token and quote legs; the price in SOL per whole token (12 decimals) or null. */
  venue?: "curve" | "damm"; baseAmountRaw?: string; quoteAmountLamports?: string; executionPriceSol?: string | null; /** quote units per whole token, 12 decimals; equals executionPriceSol for a WSOL quote */ executionPriceQuote?: string | null; quoteMint?: string; quoteDecimals?: number }
/** One launch in scope, for /api/tokens. Unknown values are null. */
export interface TokenRow {
  mint: string; decimals: number; name: string; symbol: string; imageUrl: string | null; metadataUri: string | null; metadataStatus: "ok" | "missing" | "unreachable";
  creator: string; custody: SkyRow["custody"]; config: string; tokenKind: "plain" | "stream"; dbcPool: string; dammPool: string | null; quoteMint: string; vault: string | null;
  stage: "bonding" | "completed" | "graduated";
  /** Price in quote units per whole token (12 decimals); `priceSol` repeats it only when the quote is WSOL. */
  priceQuote: string | null; priceSol: string | null; quoteDecimals: number; priceSource: string | null; priceAtMs: number; totalSupplyRaw: string;
  quoteRaisedLamports: string; targetLamports: string; progressBps: number | null; holders: number | null; holdersAtMs: number | null;
  /** Liquidity in quote lamports: the curve's quote reserve while bonding, the graduated pool's quote side x 2 after. */
  liquidityLamports: string | null; liquidityBasis: "curve-quote-reserve" | "damm-quote-x2" | null;
  /** Social links from the metadata JSON (extensions and external_url), https only. */
  links: { x: string | null; telegram: string | null; discord: string | null; website: string | null } | null;
  volume24hLamports: string; buys24h: number; sells24h: number; volumeComplete: boolean; createdAtMs: number | null; updatedAt: number;
}
/** One row of the public feed (docs/api.md): a program event, a trade, a launch or a graduation.
 *  Its identity is (type, signature, ordinal); `seq` is the publication sequence the store assigns
 *  on insert, and the cursor is "seq:slot:signature": unique, strictly increasing in the order rows
 *  were published, so a row indexed late still arrives after everything delivered before it. */
export interface FeedRow { seq?: number; slot: number; ordinal: number; signature: string; type: string; vault: string | null; mint: string | null; data: any; provenance: any; at: number }
/** Where the trade index stands on one pool. `head` is the newest signature whose history is fully
 *  indexed. A catch-up walks backward from the newest signature (`newHead`) toward `head` (`target`)
 *  in bounded pages, continuing from `tail`; only when the walk reaches the target does head move,
 *  so no interval is ever skipped. `tail` set means the pool is still catching up. */
export interface PoolCursor { head: string | null; tail: string | null; target: string | null; newHead: string | null; /** "ok" after a successful catch-up; "pending" while catching up, after an interrupted pass, or before the first successful one. */ status: "ok" | "pending" }
export interface SkyRow {
  pool: string; config: string; baseMint: string; quoteMint: string; creator: string; custody: "wallet" | "program" | "unknown";
  progress: number; eligible: boolean; reasons: string[]; creatorPct: number; partnerPct: number; creatorFeePct: number;
  claimableLamports: string;
  /** floor(total trading quote fee x creator%) - claimable: an aggregate estimate, at most one lamport per trade above the true accrual. */
  realizedEstimateLamports: string;
  /** Realized income from this vault's harvest events in the last 7 and 30 days; null when no vault holds the stream. */
  realized7dLamports: string | null; realized30dLamports: string | null; vault: string | null;
  tradingFeeLamports: string; dammPool: string | null; updatedAt: number;
  /** "curve": a DBC pool and its creator rights (the default). "position": a permanently locked DAMM v2 position of a
   *  migrated pool, keyed by the position address in `pool`, with the NFT holder in `creator`/`owner`. */
  kind?: "curve" | "position"; position?: string | null; owner?: string;
  /** Position rows: the position's permanent liquidity as a percentage of the pool's permanent total. */
  lockedSharePct?: number;
}

export interface Store {
  init(): Promise<void>;
  getCursor(): Promise<string | null>;
  setCursor(signature: string): Promise<void>;
  insertEvents(rows: EventRow[], cursor: string): Promise<void>;
  /** The trade index's cursor per pool, separate from the program cursor. */
  getPoolCursor(key: string): Promise<PoolCursor | null>;
  setPoolCursor(key: string, cursor: PoolCursor): Promise<void>;
  listPoolCursors(): Promise<{ key: string; cursor: PoolCursor }[]>;
  /** Idempotent: a trade is keyed by (signature, ordinal, pool). */
  insertTrades(rows: TradeRow[]): Promise<void>;
  /** Trades, newest first, of one vault or all. */
  listTrades(vault: string | null, limit: number): Promise<TradeRow[]>;
  /** Trades of the given pools since a unix time (all of them). */
  listTradesSince(pools: string[], sinceUnix: number): Promise<TradeRow[]>;
  /** Trades of the given pools, newest first, before an optional (slot, idx) cursor. */
  listTradesByPools(pools: string[], limit: number, before?: { slot: number; idx: number; signature: string } | null): Promise<TradeRow[]>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  upsertTokens(rows: TokenRow[]): Promise<void>;
  pruneTokens(keep: string[]): Promise<void>;
  listTokens(): Promise<TokenRow[]>;
  getToken(mint: string): Promise<TokenRow | null>;
  /** The newest slot the store has seen (events or trades), null when empty. */
  observedSlot(): Promise<number | null>;
  upsertVault(vault: string, data: any): Promise<void>;
  upsertStream(stream: string, vault: string, data: any): Promise<void>;
  /** After a complete snapshot: drop streams of the vault that are no longer on chain (withdrawn). */
  pruneStreams(vault: string, keep: string[]): Promise<void>;
  upsertSky(rows: SkyRow[]): Promise<void>;
  /** After a complete scan: drop pools the scan no longer returned. */
  pruneSky(keep: string[]): Promise<void>;
  listAllStreams(): Promise<{ stream: string; vault: string; data: any }[]>;
  /** Events of the given names since a unix time, oldest first. */
  listEventsSince(names: string[], sinceUnix: number): Promise<EventRow[]>;
  listVaults(): Promise<{ vault: string; data: any; updatedAt: number }[]>;
  getVault(vault: string): Promise<{ vault: string; data: any; updatedAt: number } | null>;
  listStreams(vault: string): Promise<{ stream: string; data: any }[]>;
  listEvents(vault: string | null, limit: number): Promise<EventRow[]>;
  listSky(limit: number): Promise<SkyRow[]>;
  /** The feed: append (idempotent on the cursor), read forward from an exclusive cursor, the bounds, and retention. */
  /** Appends what is new (identity (type, signature, ordinal)) and returns those rows with their sequence. */
  appendFeed(rows: FeedRow[]): Promise<FeedRow[]>;
  /** The token snapshot and the feed rows it implies, committed together; returns the feed rows inserted. */
  upsertTokensAndFeed(tokens: TokenRow[], keep: string[], feed: FeedRow[]): Promise<FeedRow[]>;
  listFeedSince(since: { seq: number } | null, limit: number): Promise<FeedRow[]>;
  oldestFeed(): Promise<FeedRow | null>;
  headFeed(): Promise<FeedRow | null>;
  pruneFeed(beforeSlot: number): Promise<void>;
  close(): Promise<void>;
}

/** Schema version: a store written by an older version is rebuilt from the chain (the chain is
 *  the source of truth for every row here), never patched by guessing at old encodings. */
export const SCHEMA_VERSION = 10;
/** Where the feed sequence starts after a rebuild: above every sequence this database issued before
 *  (its allocator's last value, which outlives pruned rows, and its last floor) and above the time in tenths of a second, so a cursor from a
 *  previous database generation, or one in the old slot-based format, always reads as expired and
 *  gets an explicit gap with a resume cursor instead of silence. Twelve digits at most for the
 *  SDK's cursor grammar. */
export function feedSequenceFloor(previousFloor: number, previousHead: number): number {
  return Math.min(999_999_999_999, Math.max(previousFloor, previousHead, Math.floor(Date.now() / 10)));
}

/** JSON-safe copy, converted before any serialization: bigints and BNs to decimal strings,
 *  public keys to base58, byte arrays to arrays. (JSON.stringify would call BN.toJSON first and
 *  turn amounts into bare hex, so the walk happens here, not in a replacer.) */
export function plain(v: any): any {
  if (v === null || v === undefined) return v;
  if (typeof v === "bigint") return v.toString();
  if (typeof v !== "object") return v;
  if (v instanceof PublicKey) return v.toBase58();
  if (BN.isBN(v) || (v.constructor && v.constructor.name === "BN" && typeof v.toString === "function")) return v.toString(10);
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return Array.from(v);
  if (Array.isArray(v)) return v.map(plain);
  const out: any = {};
  for (const k of Object.keys(v)) out[k] = plain(v[k]);
  return out;
}

export function openStore(url: string): Store {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) return new PgStore(url);
  if (url.startsWith("sqlite:")) return new SqliteStore(url.slice("sqlite:".length));
  throw new Error("DATABASE_URL must start with postgres:// or sqlite:");
}

// ---- Postgres ----
class PgStore implements Store {
  private pool: any;
  constructor(private url: string) {}
  async init() {
    const { Pool } = await import("pg");
    this.pool = new Pool({ connectionString: this.url });
    // the schema version decides before any table exists: a changed version drops every data table
    // (CREATE IF NOT EXISTS would keep old columns and keys) and the version is recorded last, so a
    // crash in between repeats the rebuild on the next start
    await this.pool.query("create table if not exists meta (key text primary key, value text not null)");
    const r = await this.pool.query("select value from meta where key = 'schema'");
    const have = r.rows[0] ? Number(r.rows[0].value) : 0;
    // the feed sequence never restarts below a value this database (or a previous one) issued
    let previousHead = 0;
    try { const h = await this.pool.query("select coalesce(max(seq), 0) as m from feed"); previousHead = Number(h.rows[0]?.m ?? 0); } catch { /* no feed table yet */ }
    // the allocator remembers what pruning forgot: the sequence object's last value outlives every row
    try { const q = await this.pool.query("select last_value, is_called from feed_seq_seq"); if (q.rows[0]?.is_called) previousHead = Math.max(previousHead, Number(q.rows[0].last_value)); } catch { /* no sequence yet */ }
    if (have !== SCHEMA_VERSION) {
      if (have > 0) console.log(JSON.stringify({ msg: "store schema changed: rebuilding from the chain", from: have, to: SCHEMA_VERSION }));
      // Persist the allocator before destructive DDL: a restart after the drop must retain it.
      await this.pool.query("insert into meta (key, value) values ('feed_seq_floor', $1) on conflict (key) do update set value = greatest(meta.value::bigint, excluded.value::bigint)::text", [String(previousHead)]);
      await this.pool.query("delete from meta where key not in ('schema', 'feed_seq_floor')");
      await this.pool.query("drop table if exists events, cursor, vaults, streams, sky, cursors, trades, tokens, feed");
    }
    await this.pool.query(`
      create table if not exists events (signature text not null, idx int not null, slot bigint not null, block_time bigint, name text not null, vault text, data jsonb not null, primary key (signature, idx));
      create index if not exists events_vault_idx on events (vault);
      create table if not exists cursor (id int primary key, signature text not null);
      create table if not exists vaults (vault text primary key, data jsonb not null, updated_at bigint not null);
      create table if not exists streams (stream text primary key, vault text not null, data jsonb not null, updated_at bigint not null);
      create table if not exists sky (pool text primary key, data jsonb not null, updated_at bigint not null);
      create table if not exists cursors (key text primary key, head text, tail text, target text, new_head text, status text not null default 'pending');
      create table if not exists trades (signature text not null, idx int not null, slot bigint not null, block_time bigint, pool text not null, vault text not null, trader text not null, trader_kind text not null, buy boolean not null, amount_in text not null, amount_out text not null, venue text, base_amount text, quote_amount text, price text, primary key (signature, idx, pool));
      create index if not exists trades_pool_idx on trades (pool, slot desc, idx desc);
      create table if not exists tokens (mint text primary key, data jsonb not null, volume24h numeric not null, updated_at bigint not null);
      create table if not exists feed (seq bigserial primary key, slot bigint not null, ordinal int not null, signature text not null, type text not null, vault text, mint text, data jsonb not null, provenance jsonb not null, at bigint not null, unique (type, signature, ordinal));`);
    if (have !== SCHEMA_VERSION) {
      const f = await this.pool.query("select value from meta where key = 'feed_seq_floor'");
      const floor = feedSequenceFloor(Number(f.rows[0]?.value ?? 0), previousHead);
      await this.pool.query("select setval('feed_seq_seq', $1, true)", [floor]);
      await this.pool.query("insert into meta (key, value) values ('feed_seq_floor', $1) on conflict (key) do update set value = $1", [String(floor)]);
      await this.pool.query("insert into meta (key, value) values ('schema', $1) on conflict (key) do update set value = $1", [String(SCHEMA_VERSION)]);
    }
  }
  async pruneStreams(vault: string, keep: string[]) { await this.pool.query("delete from streams where vault = $1 and not (stream = any($2))", [vault, keep]); }
  async pruneSky(keep: string[]) { await this.pool.query("delete from sky where not (pool = any($1))", [keep]); }
  async listAllStreams() { const r = await this.pool.query("select stream, vault, data from streams"); return r.rows; }
  async listEventsSince(names: string[], sinceUnix: number) {
    const r = await this.pool.query("select * from events where name = any($1) and block_time >= $2 order by slot asc, idx asc", [names, sinceUnix]);
    return r.rows.map((x: any) => ({ signature: x.signature, idx: x.idx, slot: Number(x.slot), blockTime: x.block_time === null ? null : Number(x.block_time), name: x.name, vault: x.vault, data: x.data }));
  }
  async getCursor() { const r = await this.pool.query("select signature from cursor where id = 1"); return r.rows[0]?.signature ?? null; }
  async getPoolCursor(key: string) { const r = await this.pool.query("select head, tail, target, new_head, status from cursors where key = $1", [key]); return r.rows[0] ? { head: r.rows[0].head, tail: r.rows[0].tail, target: r.rows[0].target, newHead: r.rows[0].new_head, status: r.rows[0].status } : null; }
  async setPoolCursor(key: string, c: PoolCursor) { await this.pool.query("insert into cursors (key, head, tail, target, new_head, status) values ($1,$2,$3,$4,$5,$6) on conflict (key) do update set head = $2, tail = $3, target = $4, new_head = $5, status = $6", [key, c.head, c.tail, c.target, c.newHead, c.status]); }
  async listPoolCursors() { const r = await this.pool.query("select key, head, tail, target, new_head, status from cursors"); return r.rows.map((x: any) => ({ key: x.key, cursor: { head: x.head, tail: x.tail, target: x.target, newHead: x.new_head, status: x.status } })); }
  async insertTrades(rows: TradeRow[]) {
    for (const r of rows) await this.pool.query("insert into trades (signature, idx, slot, block_time, pool, vault, trader, trader_kind, buy, amount_in, amount_out, venue, base_amount, quote_amount, price) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) on conflict do nothing", [r.signature, r.idx, r.slot, r.blockTime, r.pool, r.vault, r.trader, r.traderKind, r.buy, r.amountIn, r.amountOut, r.venue ?? null, r.baseAmountRaw ?? null, r.quoteAmountLamports ?? null, r.executionPriceSol ?? null]);
  }
  async listTrades(vault: string | null, limit: number) {
    const r = vault ? await this.pool.query("select * from trades where vault = $1 order by slot desc, idx desc limit $2", [vault, limit]) : await this.pool.query("select * from trades order by slot desc, idx desc limit $1", [limit]);
    return r.rows.map(pgTrade);
  }
  async listTradesSince(pools: string[], sinceUnix: number) { if (!pools.length) return []; const r = await this.pool.query("select * from trades where pool = any($1) and block_time >= $2", [pools, sinceUnix]); return r.rows.map(pgTrade); }
  async listTradesByPools(pools: string[], limit: number, before?: { slot: number; idx: number; signature: string } | null) {
    if (!pools.length) return [];
    const r = before ? await this.pool.query("select * from trades where pool = any($1) and (slot < $2 or (slot = $2 and idx < $3) or (slot = $2 and idx = $3 and signature < $4)) order by slot desc, idx desc, signature desc limit $5", [pools, before.slot, before.idx, before.signature, limit]) : await this.pool.query("select * from trades where pool = any($1) order by slot desc, idx desc, signature desc limit $2", [pools, limit]);
    return r.rows.map(pgTrade);
  }
  async getMeta(key: string) { const r = await this.pool.query("select value from meta where key = $1", [key]); return r.rows[0]?.value ?? null; }
  async setMeta(key: string, value: string) { await this.pool.query("insert into meta (key, value) values ($1, $2) on conflict (key) do update set value = $2", [key, value]); }
  async upsertTokens(rows: TokenRow[]) { await this.upsertTokensWith(this.pool, rows); }
  private async upsertTokensWith(q: { query: (text: string, values?: any[]) => Promise<any> }, rows: TokenRow[]) { for (const t of rows) await q.query("insert into tokens (mint, data, volume24h, updated_at) values ($1,$2,$3,$4) on conflict (mint) do update set data = $2, volume24h = $3, updated_at = $4", [t.mint, t, t.volume24hLamports, t.updatedAt]); }
  async pruneTokens(keep: string[]) { await this.pool.query("delete from tokens where not (mint = any($1))", [keep]); }
  async upsertTokensAndFeed(tokens: TokenRow[], keep: string[], feed: FeedRow[]) {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      await this.upsertTokensWith(c, tokens);
      await c.query("delete from tokens where not (mint = any($1))", [keep]);
      const inserted = await this.appendFeedWith(c, feed);
      await c.query("insert into meta (key, value) values ('tokens_scanned_at', $1) on conflict (key) do update set value = $1", [String(Date.now())]);
      await c.query("commit");
      return inserted;
    } catch (e) { try { await c.query("rollback"); } catch { /* connection gone */ } throw e; } finally { c.release(); }
  }
  async listTokens() { const r = await this.pool.query("select data from tokens"); return r.rows.map((x: any) => x.data); }
  async getToken(mint: string) { const r = await this.pool.query("select data from tokens where mint = $1", [mint]); return r.rows[0]?.data ?? null; }
  async observedSlot() { const r = await this.pool.query("select greatest((select max(slot) from events), (select max(slot) from trades)) as s"); return r.rows[0]?.s === null || r.rows[0]?.s === undefined ? null : Number(r.rows[0].s); }
  async setCursor(s: string) { await this.pool.query("insert into cursor (id, signature) values (1, $1) on conflict (id) do update set signature = $1", [s]); }
  async insertEvents(rows: EventRow[], cursor: string) {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      for (const r of rows) await c.query("insert into events (signature, idx, slot, block_time, name, vault, data) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing", [r.signature, r.idx, r.slot, r.blockTime, r.name, r.vault, r.data]);
      await c.query("insert into cursor (id, signature) values (1, $1) on conflict (id) do update set signature = $1", [cursor]);
      await c.query("commit");
    } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  }
  async upsertVault(vault: string, data: any) { await this.pool.query("insert into vaults (vault, data, updated_at) values ($1,$2,$3) on conflict (vault) do update set data = $2, updated_at = $3", [vault, data, Date.now()]); }
  async upsertStream(stream: string, vault: string, data: any) { await this.pool.query("insert into streams (stream, vault, data, updated_at) values ($1,$2,$3,$4) on conflict (stream) do update set data = $3, updated_at = $4", [stream, vault, data, Date.now()]); }
  async upsertSky(rows: SkyRow[]) { for (const r of rows) await this.pool.query("insert into sky (pool, data, updated_at) values ($1,$2,$3) on conflict (pool) do update set data = $2, updated_at = $3", [r.pool, r, r.updatedAt]); }
  async listVaults() { const r = await this.pool.query("select vault, data, updated_at from vaults order by updated_at desc"); return r.rows.map((x: any) => ({ vault: x.vault, data: x.data, updatedAt: Number(x.updated_at) })); }
  async getVault(vault: string) { const r = await this.pool.query("select vault, data, updated_at from vaults where vault = $1", [vault]); return r.rows[0] ? { vault: r.rows[0].vault, data: r.rows[0].data, updatedAt: Number(r.rows[0].updated_at) } : null; }
  async listStreams(vault: string) { const r = await this.pool.query("select stream, data from streams where vault = $1", [vault]); return r.rows; }
  async listEvents(vault: string | null, limit: number) {
    const r = vault ? await this.pool.query("select * from events where vault = $1 order by slot desc, idx desc limit $2", [vault, limit]) : await this.pool.query("select * from events order by slot desc, idx desc limit $1", [limit]);
    return r.rows.map((x: any) => ({ signature: x.signature, idx: x.idx, slot: Number(x.slot), blockTime: x.block_time === null ? null : Number(x.block_time), name: x.name, vault: x.vault, data: x.data }));
  }
  async listSky(limit: number) { const r = await this.pool.query("select data from sky order by (data->>'claimableLamports')::numeric desc limit $1", [limit]); return r.rows.map((x: any) => x.data); }
  async appendFeed(rows: FeedRow[]) { return this.appendFeedWith(this.pool, rows); }
  private async appendFeedWith(q: { query: (text: string, values?: any[]) => Promise<any> }, rows: FeedRow[]) {
    const out: FeedRow[] = [];
    for (const r of rows) {
      const res = await q.query("insert into feed (slot, ordinal, signature, type, vault, mint, data, provenance, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (type, signature, ordinal) do nothing returning *", [r.slot, r.ordinal, r.signature, r.type, r.vault, r.mint, r.data, r.provenance, r.at]);
      if (res.rows[0]) out.push(pgFeed(res.rows[0]));
    }
    return out;
  }
  async listFeedSince(since: { seq: number } | null, limit: number) {
    const r = since
      ? await this.pool.query("select * from feed where seq > $1 order by seq asc limit $2", [since.seq, limit])
      : await this.pool.query("select * from feed order by seq asc limit $1", [limit]);
    return r.rows.map(pgFeed);
  }
  async oldestFeed() { const r = await this.pool.query("select * from feed order by seq asc limit 1"); return r.rows[0] ? pgFeed(r.rows[0]) : null; }
  async headFeed() { const r = await this.pool.query("select * from feed order by seq desc limit 1"); return r.rows[0] ? pgFeed(r.rows[0]) : null; }
  async pruneFeed(beforeSlot: number) { await this.pool.query("delete from feed where slot < $1", [beforeSlot]); }
  async close() { await this.pool.end(); }
}

// ---- SQLite (node:sqlite) ----
class SqliteStore implements Store {
  private db: any;
  constructor(private file: string) {}
  async init() {
    const { DatabaseSync } = await import("node:sqlite");
    this.db = new DatabaseSync(this.file);
    this.db.exec("create table if not exists meta (key text primary key, value text not null)");
    const r = this.db.prepare("select value from meta where key = 'schema'").get();
    const have = r ? Number(r.value) : 0;
    // the feed sequence never restarts below a value this database (or a previous one) issued
    let previousHead = 0;
    try { const h: any = this.db.prepare("select coalesce(max(seq), 0) as m from feed").get(); previousHead = Number(h?.m ?? 0); } catch { /* no feed table yet */ }
    // the allocator remembers what pruning forgot: sqlite_sequence keeps the last value issued after every row is gone
    try { const q: any = this.db.prepare("select seq from sqlite_sequence where name = 'feed'").get(); if (q) previousHead = Math.max(previousHead, Number(q.seq)); } catch { /* no sequence row yet */ }
    if (have !== SCHEMA_VERSION) {
      if (have > 0) console.log(JSON.stringify({ msg: "store schema changed: rebuilding from the chain", from: have, to: SCHEMA_VERSION }));
      // Persist the allocator before destructive DDL: a restart after the drop must retain it.
      this.db.prepare("insert into meta (key, value) values ('feed_seq_floor', ?) on conflict (key) do update set value = cast(max(cast(meta.value as integer), cast(excluded.value as integer)) as text)").run(String(previousHead));
      this.db.exec("delete from meta where key not in ('schema', 'feed_seq_floor')");
      this.db.exec("drop table if exists events; drop table if exists cursor; drop table if exists vaults; drop table if exists streams; drop table if exists sky; drop table if exists cursors; drop table if exists feed; drop table if exists trades; drop table if exists tokens");
    }
    this.db.exec(`
      create table if not exists events (signature text not null, idx integer not null, slot integer not null, block_time integer, name text not null, vault text, data text not null, primary key (signature, idx));
      create index if not exists events_vault_idx on events (vault);
      create table if not exists cursor (id integer primary key, signature text not null);
      create table if not exists vaults (vault text primary key, data text not null, updated_at integer not null);
      create table if not exists streams (stream text primary key, vault text not null, data text not null, updated_at integer not null);
      create table if not exists sky (pool text primary key, data text not null, claimable text not null, updated_at integer not null);
      create table if not exists cursors (key text primary key, head text, tail text, target text, new_head text, status text not null default 'pending');
      create table if not exists trades (signature text not null, idx integer not null, slot integer not null, block_time integer, pool text not null, vault text not null, trader text not null, trader_kind text not null, buy integer not null, amount_in text not null, amount_out text not null, venue text, base_amount text, quote_amount text, price text, primary key (signature, idx, pool));
      create index if not exists trades_pool_idx on trades (pool, slot desc, idx desc);
      create table if not exists tokens (mint text primary key, data text not null, volume24h text not null, updated_at integer not null);
      create table if not exists feed (seq integer primary key autoincrement, slot integer not null, ordinal integer not null, signature text not null, type text not null, vault text, mint text, data text not null, provenance text not null, at integer not null, unique (type, signature, ordinal));`);
    if (have !== SCHEMA_VERSION) {
      const f: any = this.db.prepare("select value from meta where key = 'feed_seq_floor'").get();
      const floor = feedSequenceFloor(Number(f?.value ?? 0), previousHead);
      this.db.exec("delete from sqlite_sequence where name = 'feed'");
      this.db.prepare("insert into sqlite_sequence (name, seq) values ('feed', ?)").run(floor);
      this.db.prepare("insert into meta (key, value) values ('feed_seq_floor', ?) on conflict (key) do update set value = excluded.value").run(String(floor));
      this.db.prepare("insert into meta (key, value) values ('schema', ?) on conflict (key) do update set value = excluded.value").run(String(SCHEMA_VERSION));
    }
  }
  async pruneStreams(vault: string, keep: string[]) {
    const rows = this.db.prepare("select stream from streams where vault = ?").all(vault);
    const del = this.db.prepare("delete from streams where stream = ?");
    for (const r of rows) if (!keep.includes(r.stream)) del.run(r.stream);
  }
  async pruneSky(keep: string[]) {
    const rows = this.db.prepare("select pool from sky").all();
    const del = this.db.prepare("delete from sky where pool = ?");
    for (const r of rows) if (!keep.includes(r.pool)) del.run(r.pool);
  }
  async listAllStreams() { return this.db.prepare("select stream, vault, data from streams").all().map((x: any) => ({ stream: x.stream, vault: x.vault, data: JSON.parse(x.data) })); }
  async listEventsSince(names: string[], sinceUnix: number) {
    const rows = this.db.prepare(`select * from events where name in (${names.map(() => "?").join(",")}) and block_time >= ? order by slot asc, idx asc`).all(...names, sinceUnix);
    return rows.map((x: any) => ({ signature: x.signature, idx: x.idx, slot: x.slot, blockTime: x.block_time, name: x.name, vault: x.vault, data: JSON.parse(x.data) }));
  }
  async getCursor() { const r = this.db.prepare("select signature from cursor where id = 1").get(); return r ? r.signature : null; }
  async getPoolCursor(key: string) { const x = this.db.prepare("select head, tail, target, new_head, status from cursors where key = ?").get(key); return x ? { head: x.head, tail: x.tail, target: x.target, newHead: x.new_head, status: x.status } : null; }
  async setPoolCursor(key: string, c: PoolCursor) { this.db.prepare("insert into cursors (key, head, tail, target, new_head, status) values (?,?,?,?,?,?) on conflict (key) do update set head = excluded.head, tail = excluded.tail, target = excluded.target, new_head = excluded.new_head, status = excluded.status").run(key, c.head, c.tail, c.target, c.newHead, c.status); }
  async listPoolCursors() { return this.db.prepare("select key, head, tail, target, new_head, status from cursors").all().map((x: any) => ({ key: x.key, cursor: { head: x.head, tail: x.tail, target: x.target, newHead: x.new_head, status: x.status } })); }
  async insertTrades(rows: TradeRow[]) {
    const ins = this.db.prepare("insert or ignore into trades (signature, idx, slot, block_time, pool, vault, trader, trader_kind, buy, amount_in, amount_out, venue, base_amount, quote_amount, price) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const r of rows) ins.run(r.signature, r.idx, r.slot, r.blockTime, r.pool, r.vault, r.trader, r.traderKind, r.buy ? 1 : 0, r.amountIn, r.amountOut, r.venue ?? null, r.baseAmountRaw ?? null, r.quoteAmountLamports ?? null, r.executionPriceSol ?? null);
  }
  async listTrades(vault: string | null, limit: number) {
    const rows = vault ? this.db.prepare("select * from trades where vault = ? order by slot desc, idx desc limit ?").all(vault, limit) : this.db.prepare("select * from trades order by slot desc, idx desc limit ?").all(limit);
    return rows.map(sqTrade);
  }
  async listTradesSince(pools: string[], sinceUnix: number) { if (!pools.length) return []; return this.db.prepare(`select * from trades where pool in (${pools.map(() => "?").join(",")}) and block_time >= ?`).all(...pools, sinceUnix).map(sqTrade); }
  async listTradesByPools(pools: string[], limit: number, before?: { slot: number; idx: number; signature: string } | null) {
    if (!pools.length) return [];
    const ph = pools.map(() => "?").join(",");
    const rows = before ? this.db.prepare(`select * from trades where pool in (${ph}) and (slot < ? or (slot = ? and idx < ?) or (slot = ? and idx = ? and signature < ?)) order by slot desc, idx desc, signature desc limit ?`).all(...pools, before.slot, before.slot, before.idx, before.slot, before.idx, before.signature, limit) : this.db.prepare(`select * from trades where pool in (${ph}) order by slot desc, idx desc, signature desc limit ?`).all(...pools, limit);
    return rows.map(sqTrade);
  }
  async getMeta(key: string) { const x = this.db.prepare("select value from meta where key = ?").get(key); return x ? x.value : null; }
  async setMeta(key: string, value: string) { this.db.prepare("insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(key, value); }
  async upsertTokens(rows: TokenRow[]) { this.upsertTokensSync(rows); }
  private upsertTokensSync(rows: TokenRow[]) { const ins = this.db.prepare("insert into tokens (mint, data, volume24h, updated_at) values (?,?,?,?) on conflict (mint) do update set data = excluded.data, volume24h = excluded.volume24h, updated_at = excluded.updated_at"); for (const t of rows) ins.run(t.mint, JSON.stringify(t), t.volume24hLamports, t.updatedAt); }
  async pruneTokens(keep: string[]) { this.pruneTokensSync(keep); }
  private pruneTokensSync(keep: string[]) { const rows = this.db.prepare("select mint from tokens").all(); const del = this.db.prepare("delete from tokens where mint = ?"); const k = new Set(keep); for (const r of rows) if (!k.has(r.mint)) del.run(r.mint); }
  async upsertTokensAndFeed(tokens: TokenRow[], keep: string[], feed: FeedRow[]) {
    this.db.exec("begin");
    try { this.upsertTokensSync(tokens); this.pruneTokensSync(keep); const inserted = this.appendFeedSync(feed); this.db.prepare("insert into meta (key, value) values ('tokens_scanned_at', ?) on conflict (key) do update set value = excluded.value").run(String(Date.now())); this.db.exec("commit"); return inserted; }
    catch (e) { try { this.db.exec("rollback"); } catch { /* already rolled back */ } throw e; }
  }
  async listTokens() { return this.db.prepare("select data from tokens").all().map((x: any) => JSON.parse(x.data)); }
  async getToken(mint: string) { const x = this.db.prepare("select data from tokens where mint = ?").get(mint); return x ? JSON.parse(x.data) : null; }
  async observedSlot() { const x = this.db.prepare("select max(s) as s from (select max(slot) as s from events union all select max(slot) as s from trades)").get(); return x && x.s !== null && x.s !== undefined ? Number(x.s) : null; }
  async setCursor(s: string) { this.db.prepare("insert into cursor (id, signature) values (1, ?) on conflict (id) do update set signature = excluded.signature").run(s); }
  async insertEvents(rows: EventRow[], cursor: string) {
    this.db.exec("begin");
    try {
      const ins = this.db.prepare("insert or ignore into events (signature, idx, slot, block_time, name, vault, data) values (?,?,?,?,?,?,?)");
      for (const r of rows) ins.run(r.signature, r.idx, r.slot, r.blockTime, r.name, r.vault, JSON.stringify(r.data));
      await this.setCursor(cursor);
      this.db.exec("commit");
    } catch (e) { this.db.exec("rollback"); throw e; }
  }
  async upsertVault(vault: string, data: any) { this.db.prepare("insert into vaults (vault, data, updated_at) values (?,?,?) on conflict (vault) do update set data = excluded.data, updated_at = excluded.updated_at").run(vault, JSON.stringify(data), Date.now()); }
  async upsertStream(stream: string, vault: string, data: any) { this.db.prepare("insert into streams (stream, vault, data, updated_at) values (?,?,?,?) on conflict (stream) do update set data = excluded.data, updated_at = excluded.updated_at").run(stream, vault, JSON.stringify(data), Date.now()); }
  async upsertSky(rows: SkyRow[]) {
    const ins = this.db.prepare("insert into sky (pool, data, claimable, updated_at) values (?,?,?,?) on conflict (pool) do update set data = excluded.data, claimable = excluded.claimable, updated_at = excluded.updated_at");
    for (const r of rows) ins.run(r.pool, JSON.stringify(r), r.claimableLamports.padStart(24, "0"), r.updatedAt);
  }
  async listVaults() { return this.db.prepare("select vault, data, updated_at from vaults order by updated_at desc").all().map((x: any) => ({ vault: x.vault, data: JSON.parse(x.data), updatedAt: x.updated_at })); }
  async getVault(vault: string) { const x = this.db.prepare("select vault, data, updated_at from vaults where vault = ?").get(vault); return x ? { vault: x.vault, data: JSON.parse(x.data), updatedAt: x.updated_at } : null; }
  async listStreams(vault: string) { return this.db.prepare("select stream, data from streams where vault = ?").all(vault).map((x: any) => ({ stream: x.stream, data: JSON.parse(x.data) })); }
  async listEvents(vault: string | null, limit: number) {
    const rows = vault ? this.db.prepare("select * from events where vault = ? order by slot desc, idx desc limit ?").all(vault, limit) : this.db.prepare("select * from events order by slot desc, idx desc limit ?").all(limit);
    return rows.map((x: any) => ({ signature: x.signature, idx: x.idx, slot: x.slot, blockTime: x.block_time, name: x.name, vault: x.vault, data: JSON.parse(x.data) }));
  }
  async listSky(limit: number) { return this.db.prepare("select data from sky order by claimable desc limit ?").all(limit).map((x: any) => JSON.parse(x.data)); }
  async appendFeed(rows: FeedRow[]) { return this.appendFeedSync(rows); }
  private appendFeedSync(rows: FeedRow[]): FeedRow[] {
    const ins = this.db.prepare("insert into feed (slot, ordinal, signature, type, vault, mint, data, provenance, at) values (?,?,?,?,?,?,?,?,?) on conflict (type, signature, ordinal) do nothing returning *");
    const out: FeedRow[] = [];
    for (const r of rows) { const x = ins.get(r.slot, r.ordinal, r.signature, r.type, r.vault, r.mint, JSON.stringify(r.data), JSON.stringify(r.provenance), r.at); if (x) out.push(sqFeed(x)); }
    return out;
  }
  async listFeedSince(since: { seq: number } | null, limit: number) {
    const rows = since
      ? this.db.prepare("select * from feed where seq > ? order by seq asc limit ?").all(since.seq, limit)
      : this.db.prepare("select * from feed order by seq asc limit ?").all(limit);
    return rows.map(sqFeed);
  }
  async oldestFeed() { const x = this.db.prepare("select * from feed order by seq asc limit 1").get(); return x ? sqFeed(x) : null; }
  async headFeed() { const x = this.db.prepare("select * from feed order by seq desc limit 1").get(); return x ? sqFeed(x) : null; }
  async pruneFeed(beforeSlot: number) { this.db.prepare("delete from feed where slot < ?").run(beforeSlot); }
  async close() { this.db.close(); }
}

function pgTrade(x: any): TradeRow { return { signature: x.signature, idx: x.idx, slot: Number(x.slot), blockTime: x.block_time === null ? null : Number(x.block_time), pool: x.pool, vault: x.vault, trader: x.trader, traderKind: x.trader_kind, buy: x.buy, amountIn: x.amount_in, amountOut: x.amount_out, venue: x.venue ?? undefined, baseAmountRaw: x.base_amount ?? undefined, quoteAmountLamports: x.quote_amount ?? undefined, executionPriceSol: x.price ?? null }; }
function sqTrade(x: any): TradeRow { return { signature: x.signature, idx: x.idx, slot: x.slot, blockTime: x.block_time, pool: x.pool, vault: x.vault, trader: x.trader, traderKind: x.trader_kind, buy: !!x.buy, amountIn: x.amount_in, amountOut: x.amount_out, venue: x.venue ?? undefined, baseAmountRaw: x.base_amount ?? undefined, quoteAmountLamports: x.quote_amount ?? undefined, executionPriceSol: x.price ?? null }; }

function pgFeed(x: any): FeedRow { return { seq: Number(x.seq), slot: Number(x.slot), ordinal: x.ordinal, signature: x.signature, type: x.type, vault: x.vault, mint: x.mint, data: x.data, provenance: x.provenance, at: Number(x.at) }; }
function sqFeed(x: any): FeedRow { return { seq: Number(x.seq), slot: x.slot, ordinal: x.ordinal, signature: x.signature, type: x.type, vault: x.vault, mint: x.mint, data: JSON.parse(x.data), provenance: JSON.parse(x.provenance), at: x.at }; }
