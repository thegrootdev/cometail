// The Fee Index: every SOL-paired Meteora DBC coin, from any launchpad, with what its creator earns.
//
// Coverage without hammering the RPC. The DBC program holds about 1.75 million pools and half a
// million configs, so nothing here scans the program with plain getProgramAccounts (the provider
// refuses it). Instead:
//   - a FULL walk, at start and then daily: every SOL-quoted config (one paginated, sliced
//     getProgramAccountsV2 walk filtered on the quote mint, about one minute), then every pool (the
//     same, 296 bytes per pool from the config address through the creator fee, about four
//     minutes);
//   - a DELTA walk every few minutes: the same pool walk with changedSinceSlot, which returns only
//     pools written since the last walk (fifteen minutes is about a hundred pools, ten seconds).
// Configs are immutable once created, so each is read once; a pool on a config the cache has not
// seen yet brings that config in through a sliced getMultipleAccounts.
//
// What is kept: pools on SOL-quoted configs that ever paid their creator (lifetime creator fee or a
// claimable creator fee above zero). What is derived: the creator's lifetime curve fees (the pool's
// lifetime trading-fee counter times the config's creator share), the creator fee claimable now,
// the last 24 hours (hourly snapshots of the counter, kept 48 hours), the average per day since
// activation, the graduation stage, and whether the config lets the coin's creator rights launch a
// tail (the program's own deposit rules, eligibility.rs check_dbc_rights). Post-graduation fees on
// the creator's locked DAMM v2 position are not in the DBC pool: the coin detail reads them live.
//
// Claims: when a pool's claimable creator or partner fee falls between walks, the fee was claimed.
// The pool's recent transactions are read to find the claim event with its exact amounts, which is
// published on the public feed as a `claim` row.
import { Connection, PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { createHash } from "crypto";
import { Chain, DBC_PROGRAM_ID } from "./chain";
import { readTx } from "./indexer";
import { publish } from "./feed";
import type { Store, FeedRow } from "./store";
import { parseMetaplexMetadata } from "./tokens";
import { log } from "./tx";

const WSOL = "So11111111111111111111111111111111111111112";
const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const EVENT_IX = Buffer.from("e445a52e51cb9a1d", "hex");
const accountDisc = (name: string) => utils.bytes.bs58.encode(createHash("sha256").update(`account:${name}`).digest().subarray(0, 8));
export const POOL_DISC = accountDisc("VirtualPool");
export const CONFIG_DISC = accountDisc("PoolConfig");

/** Byte offsets in the DBC accounts (VirtualPool 424 bytes, PoolConfig 1048 bytes; from the program's IDL). */
export const POOL = { config: 72, creator: 104, baseMint: 136, quoteReserve: 240, partnerQuoteFee: 272, activationPoint: 296, migrationProgress: 308, totalTradingQuoteFee: 336, finishCurveTimestamp: 344, creatorQuoteFee: 360 } as const;
export const POOL_SLICE = { offset: 72, length: 296 } as const;
export const CONFIG = { quoteMint: 8, feeClaimer: 40, creatorVestingPercentage: 201, collectFeeMode: 232, migrationOption: 233, activationType: 234, partnerLocked: 239, creatorLocked: 241, creatorLiquidity: 242, migrationFeeOption: 243, creatorTradingFeePercentage: 245, migrationQuoteThreshold: 264, migratedCollectFeeMode: 360 } as const;
export const CONFIG_SLICE = { offset: 8, length: 360 } as const;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (b: Uint8Array) => utils.bytes.bs58.encode(b);
void ALPHABET;

export interface IndexPool { pool: string; config: string; creator: string; mint: string; progress: number; ttq: bigint; creatorFee: bigint; partnerFee: bigint; quoteReserve: bigint; activation: bigint; finishTs: number }
export interface IndexConfig { config: string; quoteMint: string; feeClaimer: string; creatorPct: number; activationType: number; partnerLocked: number; creatorLocked: number; threshold: bigint; reasons: string[] }

/** One pool from its 296-byte slice (account offsets 72..368). */
export function decodePoolSlice(pool: string, d: Buffer): IndexPool {
  const at = (abs: number) => abs - POOL_SLICE.offset;
  const u64 = (abs: number) => d.readBigUInt64LE(at(abs));
  return {
    pool, config: b58(d.subarray(at(POOL.config), at(POOL.config) + 32)), creator: b58(d.subarray(at(POOL.creator), at(POOL.creator) + 32)), mint: b58(d.subarray(at(POOL.baseMint), at(POOL.baseMint) + 32)),
    progress: d[at(POOL.migrationProgress)], ttq: u64(POOL.totalTradingQuoteFee), creatorFee: u64(POOL.creatorQuoteFee), partnerFee: u64(POOL.partnerQuoteFee), quoteReserve: u64(POOL.quoteReserve),
    activation: u64(POOL.activationPoint), finishTs: Number(u64(POOL.finishCurveTimestamp)),
  };
}

/** The config-level deposit rules for creator rights (eligibility.rs check_dbc_rights), without the pool's stage. */
export function tailReasons(c: { quoteMint: string; collectFeeMode: number; migrationOption: number; migratedCollectFeeMode: number; creatorLocked: number; creatorLiquidity: number; creatorVesting: number; migrationFeeOption: number }): string[] {
  const r: string[] = [];
  if (c.quoteMint !== WSOL) r.push("quote is not SOL");
  if (c.collectFeeMode !== 0) r.push("fees not collected in SOL");
  if (c.migrationOption !== 1) r.push("not a DAMM v2 migration");
  if (![0, 2].includes(c.migratedCollectFeeMode)) r.push("graduated pool collects fees in both tokens");
  if (c.creatorLocked === 0) r.push("creator liquidity not permanently locked");
  if (c.creatorLiquidity !== 0) r.push("creator liquidity migrates unlocked");
  if (c.creatorVesting !== 0) r.push("creator liquidity vests");
  if (c.migrationFeeOption > 6) r.push("unknown migration fee option");
  return r;
}

/** One config from its 360-byte slice (account offsets 8..368). */
export function decodeConfigSlice(config: string, d: Buffer): IndexConfig {
  const at = (abs: number) => abs - CONFIG_SLICE.offset;
  const byte = (abs: number) => d[at(abs)];
  const quoteMint = b58(d.subarray(at(CONFIG.quoteMint), at(CONFIG.quoteMint) + 32));
  const reasons = tailReasons({ quoteMint, collectFeeMode: byte(CONFIG.collectFeeMode), migrationOption: byte(CONFIG.migrationOption), migratedCollectFeeMode: byte(CONFIG.migratedCollectFeeMode), creatorLocked: byte(CONFIG.creatorLocked), creatorLiquidity: byte(CONFIG.creatorLiquidity), creatorVesting: byte(CONFIG.creatorVestingPercentage), migrationFeeOption: byte(CONFIG.migrationFeeOption) });
  return { config, quoteMint, feeClaimer: b58(d.subarray(at(CONFIG.feeClaimer), at(CONFIG.feeClaimer) + 32)), creatorPct: byte(CONFIG.creatorTradingFeePercentage), activationType: byte(CONFIG.activationType), partnerLocked: byte(CONFIG.partnerLocked), creatorLocked: byte(CONFIG.creatorLocked), threshold: d.readBigUInt64LE(at(CONFIG.migrationQuoteThreshold)), reasons };
}

export const stageOf = (progress: number) => (progress === 3 ? "graduated" : progress === 0 ? "bonding" : "migrating");
export const creatorShare = (ttq: bigint, pct: number) => (ttq * BigInt(pct)) / 100n;

export interface FeeIndexOptions { fullEveryHours: number; deltaEveryMinutes: number; pageDelayMs: number; claimLookupsPerPass: number; namesPerPass: number; ourConfigs: string[] }

/** The index's own SQLite file, apart from the main store (its schema rebuilds never touch it). */
class IndexDb {
  db: any;
  constructor(private file: string) {}
  async open() {
    const { DatabaseSync } = await import("node:sqlite");
    this.db = new DatabaseSync(this.file);
    // u64 amounts (thresholds, counters) can exceed 2^53: every statement reads integers as BigInt,
    // and every reader converts with BigInt(), Number() or String() explicitly
    const prepare = this.db.prepare.bind(this.db);
    this.db.prepare = (sql: string) => { const st = prepare(sql); st.setReadBigInts(true); return st; };
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists fi_meta (key text primary key, value text not null);
      create table if not exists fi_configs (config text primary key, fee_claimer text not null, creator_pct integer not null, activation_type integer not null, partner_locked integer not null, creator_locked integer not null, threshold integer not null, reasons text not null);
      create table if not exists fi_pools (pool text primary key, config text not null, creator text not null, mint text not null, progress integer not null, ttq integer not null, creator_fee integer not null, partner_fee integer not null, quote_reserve integer not null, activation integer not null, finish_ts integer not null, creator_life integer not null, day_income integer not null default 0, day_hours real not null default 0, changed_at integer not null, updated_at integer not null);
      create index if not exists fi_pools_creator on fi_pools (creator);
      create index if not exists fi_pools_mint on fi_pools (mint);
      create index if not exists fi_pools_config on fi_pools (config);
      create index if not exists fi_pools_life on fi_pools (creator_life desc);
      create index if not exists fi_pools_day on fi_pools (day_income desc);
      create index if not exists fi_pools_claimable on fi_pools (creator_fee desc);
      create table if not exists fi_hours (pool text not null, hour integer not null, ttq integer not null, primary key (pool, hour));
      create table if not exists fi_names (mint text primary key, name text, symbol text, checked_at integer not null);
      create table if not exists fi_claims (pool text not null, role text not null, from_slot integer not null, observed_slot integer not null, drop_lamports integer not null, resolved integer not null default 0, primary key (pool, role, observed_slot));
    `);
  }
  meta(key: string): string | null { const r = this.db.prepare("select value from fi_meta where key = ?").get(key); return r ? String(r.value) : null; }
  setMeta(key: string, value: string) { this.db.prepare("insert into fi_meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(key, value); }
  close() { this.db?.close(); }
}

export class FeeIndex {
  readonly db: IndexDb;
  private configs = new Map<string, IndexConfig | null>();
  private running = false;
  constructor(private chain: Chain, private store: Store, file: string, private opts: FeeIndexOptions) { this.db = new IndexDb(file); }
  private get conn(): Connection { return this.chain.connection; }

  async open() { await this.db.open(); for (const r of this.db.db.prepare("select * from fi_configs").all()) this.configs.set(r.config, this.configRow(r)); }
  close() { this.db.close(); }
  private configRow(r: any): IndexConfig { return { config: r.config, quoteMint: WSOL, feeClaimer: r.fee_claimer, creatorPct: Number(r.creator_pct), activationType: Number(r.activation_type), partnerLocked: Number(r.partner_locked), creatorLocked: Number(r.creator_locked), threshold: BigInt(r.threshold), reasons: JSON.parse(r.reasons) }; }

  /** getProgramAccountsV2 pages through the DBC program, with a retry per page and a pause between pages. */
  private async *walk(filters: object[], slice: { offset: number; length: number }, changedSinceSlot?: number): AsyncGenerator<{ pubkey: string; data: Buffer }[]> {
    let key: string | undefined;
    for (;;) {
      const params: any = { encoding: "base64", limit: 1000, dataSlice: slice, filters };
      if (key) params.paginationKey = key;
      if (changedSinceSlot !== undefined) params.changedSinceSlot = changedSinceSlot;
      let result: any = null, last: unknown;
      for (let i = 0; i < 6 && !result; i++) {
        try {
          const res = await fetch(this.conn.rpcEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccountsV2", params: [DBC_PROGRAM_ID.toBase58(), params] }) });
          const body: any = await res.json();
          if (body.error) throw new Error(`getProgramAccountsV2: ${body.error.message ?? JSON.stringify(body.error)}`);
          result = body.result;
        } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
      }
      if (!result) throw last;
      yield (result.accounts ?? []).map((a: any) => ({ pubkey: a.pubkey, data: Buffer.from(a.account.data[0], "base64") }));
      key = result.paginationKey ?? undefined;
      if (!key) return;
      await new Promise((r) => setTimeout(r, this.opts.pageDelayMs));
    }
  }

  private saveConfig(c: IndexConfig) {
    this.db.db.prepare("insert into fi_configs (config, fee_claimer, creator_pct, activation_type, partner_locked, creator_locked, threshold, reasons) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict (config) do nothing").run(c.config, c.feeClaimer, c.creatorPct, c.activationType, c.partnerLocked, c.creatorLocked, c.threshold.toString(), JSON.stringify(c.reasons));
  }

  /** Configs a page references that the cache does not know: read sliced, 100 at a time; non-SOL ones are remembered as null. */
  private async loadConfigs(keys: string[]) {
    const missing = [...new Set(keys)].filter((k) => !this.configs.has(k));
    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100).map((k) => new PublicKey(k));
      const res = await fetch(this.conn.rpcEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [chunk.map((k) => k.toBase58()), { encoding: "base64", dataSlice: CONFIG_SLICE, commitment: "confirmed" }] }) });
      const body: any = await res.json();
      if (body.error) throw new Error(`getMultipleAccounts: ${body.error.message}`);
      body.result.value.forEach((v: any, j: number) => {
        const k = chunk[j].toBase58();
        if (!v) { this.configs.set(k, null); return; }
        const c = decodeConfigSlice(k, Buffer.from(v.data[0], "base64"));
        if (c.quoteMint !== WSOL) { this.configs.set(k, null); return; }
        this.configs.set(k, c); this.saveConfig(c);
      });
    }
  }

  /** Upserts the kept pools of a page; returns the claims observed (a claimable fee that fell). */
  private applyPools(pools: IndexPool[], slot: number, nowMs: number, fromSlot: number): { kept: number; claims: { pool: string; role: "creator" | "partner"; drop: bigint }[] } {
    const claims: { pool: string; role: "creator" | "partner"; drop: bigint }[] = [];
    const get = this.db.db.prepare("select ttq, creator_fee, partner_fee from fi_pools where pool = ?");
    const put = this.db.db.prepare(`insert into fi_pools (pool, config, creator, mint, progress, ttq, creator_fee, partner_fee, quote_reserve, activation, finish_ts, creator_life, changed_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict (pool) do update set creator = excluded.creator, progress = excluded.progress, ttq = excluded.ttq, creator_fee = excluded.creator_fee, partner_fee = excluded.partner_fee, quote_reserve = excluded.quote_reserve, finish_ts = excluded.finish_ts, creator_life = excluded.creator_life,
        changed_at = case when fi_pools.ttq <> excluded.ttq or fi_pools.creator_fee <> excluded.creator_fee or fi_pools.progress <> excluded.progress then excluded.changed_at else fi_pools.changed_at end, updated_at = excluded.updated_at`);
    const hour = this.db.db.prepare("insert into fi_hours (pool, hour, ttq) values (?, ?, ?) on conflict do nothing");
    const h = Math.floor(nowMs / 3_600_000);
    let kept = 0;
    this.db.db.exec("begin");
    try {
      for (const p of pools) {
        const cfg = this.configs.get(p.config);
        if (!cfg) continue;
        const life = creatorShare(p.ttq, cfg.creatorPct);
        if (life === 0n && p.creatorFee === 0n) continue;
        const prev = get.get(p.pool);
        if (prev) {
          if (BigInt(prev.creator_fee) > p.creatorFee) claims.push({ pool: p.pool, role: "creator", drop: BigInt(prev.creator_fee) - p.creatorFee });
          if (BigInt(prev.partner_fee) > p.partnerFee) claims.push({ pool: p.pool, role: "partner", drop: BigInt(prev.partner_fee) - p.partnerFee });
        }
        put.run(p.pool, p.config, p.creator, p.mint, p.progress, p.ttq.toString(), p.creatorFee.toString(), p.partnerFee.toString(), p.quoteReserve.toString(), p.activation.toString(), p.finishTs, life.toString(), nowMs, nowMs);
        hour.run(p.pool, h, p.ttq.toString());
        kept++;
      }
      const claim = this.db.db.prepare("insert into fi_claims (pool, role, from_slot, observed_slot, drop_lamports) values (?, ?, ?, ?, ?) on conflict do nothing");
      for (const c of claims) claim.run(c.pool, c.role, fromSlot, slot, c.drop.toString());
      this.db.db.exec("commit");
    } catch (e) { this.db.db.exec("rollback"); throw e; }
    return { kept, claims };
  }

  /** The last 24 hours per pool from the hourly snapshots; pools quiet for a day drop to zero. */
  private refreshDayIncome(nowMs: number) {
    const h = Math.floor(nowMs / 3_600_000);
    this.db.db.exec("begin");
    try {
      // pools that changed within the last 25 hours: income since the newest snapshot at least 24 hours old, else the oldest one held
      const rows = this.db.db.prepare("select p.pool, p.ttq, c.creator_pct from fi_pools p join fi_configs c on c.config = p.config where p.changed_at >= ?").all(nowMs - 25 * 3_600_000);
      const base = this.db.db.prepare("select hour, ttq from fi_hours where pool = ? and hour <= ? order by hour desc limit 1");
      const oldest = this.db.db.prepare("select hour, ttq from fi_hours where pool = ? order by hour asc limit 1");
      const set = this.db.db.prepare("update fi_pools set day_income = ?, day_hours = ? where pool = ?");
      for (const r of rows) {
        const b = base.get(r.pool, h - 24) ?? oldest.get(r.pool);
        if (!b) continue;
        const delta = BigInt(r.ttq) - BigInt(b.ttq);
        set.run((delta > 0n ? creatorShare(delta, Number(r.creator_pct)) : 0n).toString(), Math.max(0, h - Number(b.hour)), r.pool);
      }
      this.db.db.prepare("update fi_pools set day_income = 0 where day_income <> 0 and changed_at < ?").run(nowMs - 25 * 3_600_000);
      this.db.db.prepare("delete from fi_hours where hour < ?").run(h - 48);
      this.db.db.exec("commit");
    } catch (e) { this.db.db.exec("rollback"); throw e; }
  }

  /** A full walk: every SOL config, then every pool. */
  async full(): Promise<void> {
    const t0 = Date.now();
    const slot = await this.conn.getSlot("confirmed");
    let configs = 0;
    this.db.db.exec("begin");
    try {
      for await (const page of this.walk([{ memcmp: { offset: 0, bytes: CONFIG_DISC } }, { memcmp: { offset: CONFIG.quoteMint, bytes: WSOL } }], CONFIG_SLICE)) {
        for (const a of page) { const c = decodeConfigSlice(a.pubkey, a.data); this.configs.set(a.pubkey, c); this.saveConfig(c); configs++; }
      }
      this.db.db.exec("commit");
    } catch (e) { this.db.db.exec("rollback"); throw e; }
    let pools = 0, kept = 0;
    for await (const page of this.walk([{ memcmp: { offset: 0, bytes: POOL_DISC } }], POOL_SLICE)) {
      const decoded = page.map((a) => decodePoolSlice(a.pubkey, a.data));
      await this.loadConfigs(decoded.map((p) => p.config));
      kept += this.applyPools(decoded, slot, Date.now(), Math.max(0, Number(this.db.meta("delta_slot") ?? slot) - 150)).kept; pools += decoded.length;
    }
    this.db.setMeta("full_slot", String(slot)); this.db.setMeta("delta_slot", String(slot)); this.db.setMeta("full_at", String(Date.now()));
    this.refreshDayIncome(Date.now());
    log("fee index full walk", { configs, pools, kept, seconds: Math.round((Date.now() - t0) / 1000) });
  }

  /** A delta walk: only the pools written since the last walk (with an overlap of 150 slots). */
  async delta(): Promise<void> {
    const t0 = Date.now();
    const since = Number(this.db.meta("delta_slot") ?? "0");
    const slot = await this.conn.getSlot("confirmed");
    let changed = 0, kept = 0, claims = 0;
    for await (const page of this.walk([{ memcmp: { offset: 0, bytes: POOL_DISC } }], POOL_SLICE, Math.max(0, since - 150))) {
      if (!page.length) continue;
      const decoded = page.map((a) => decodePoolSlice(a.pubkey, a.data));
      await this.loadConfigs(decoded.map((p) => p.config));
      const r = this.applyPools(decoded, slot, Date.now(), Math.max(0, since - 150)); changed += decoded.length; kept += r.kept; claims += r.claims.length;
    }
    this.db.setMeta("delta_slot", String(slot)); this.db.setMeta("delta_at", String(Date.now()));
    this.refreshDayIncome(Date.now());
    await this.resolveClaims();
    await this.fillNames();
    this.db.setMeta("summary", JSON.stringify(this.summarize()));
    log("fee index delta", { changed, kept, claims, seconds: Math.round((Date.now() - t0) / 1000) });
  }

  /** The run loop: a full walk when none is recent, deltas between; never overlapping itself. */
  async pass(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const fullAt = Number(this.db.meta("full_at") ?? "0");
      if (Date.now() - fullAt > this.opts.fullEveryHours * 3_600_000) { await this.full(); this.db.setMeta("summary", JSON.stringify(this.summarize())); await this.fillNames(); }
      else await this.delta();
    } finally { this.running = false; }
  }

  /** Exact claim amounts: the pool's newest transactions, the DBC claim events in them, published as `claim` feed rows. */
  async resolveClaims(): Promise<void> {
    const pending = this.db.db.prepare("select pool, role, from_slot, observed_slot from fi_claims where resolved = 0 order by observed_slot asc limit ?").all(this.opts.claimLookupsPerPass);
    const done = this.db.db.prepare("update fi_claims set resolved = 1 where pool = ? and role = ? and observed_slot = ?");
    const byPool = new Map<string, any[]>();
    for (const c of pending) byPool.set(c.pool, [...(byPool.get(c.pool) ?? []), c]);
    for (const [pool, rows] of byPool) {
      try {
        const mintRow = this.db.db.prepare("select mint from fi_pools where pool = ?").get(pool);
        // only the transactions inside the walk window that saw the claimable fee fall; a pool busier than
        // 25 transactions in that window may leave its claim unconfirmed (it is then not published)
        const fromSlot = Math.min(...rows.map((r: any) => Number(r.from_slot))), toSlot = Math.max(...rows.map((r: any) => Number(r.observed_slot)));
        const sigs = (await this.conn.getSignaturesForAddress(new PublicKey(pool), { limit: 25 }, "confirmed")).filter((s) => s.slot >= fromSlot && s.slot <= toSlot);
        const feed: FeedRow[] = [];
        for (const s of sigs) {
          if (s.err) continue;
          const tx = await readTx(this.conn, s.signature);
          if (!tx) continue;
          for (const ev of dbcEvents(this.chain, tx)) {
            if (ev.name !== "evtClaimCreatorTradingFee" && ev.name !== "evtClaimTradingFee") continue;
            if (String(ev.data.pool) !== pool) continue;
            const role = ev.name === "evtClaimCreatorTradingFee" ? "creator" : "partner";
            feed.push({ slot: s.slot, ordinal: ev.ordinal, signature: s.signature, type: "claim", vault: null, mint: mintRow?.mint ?? null, provenance: { source: "chain", signature: s.signature, slot: s.slot }, at: Date.now(),
              data: { mint: mintRow?.mint ?? null, pool, role, quoteAmountLamports: String(ev.data.tokenQuoteAmount ?? "0"), baseAmountRaw: String(ev.data.tokenBaseAmount ?? "0"), signature: s.signature } } as any);
          }
        }
        if (feed.length) await publish(this.store, feed);
        for (const r of rows) done.run(r.pool, r.role, r.observed_slot);
      } catch (e) { log("fee index claim lookup failed", { pool, error: String((e as Error).message ?? e) }); }
    }
  }

  /** Names for the coins people look at first: the top earners without a name yet, Metaplex metadata read 100 at a time. */
  async fillNames(): Promise<void> {
    const ours = this.opts.ourConfigs.map(() => "?").join(",") || "''";
    const rows = this.db.db.prepare(`select p.mint from fi_pools p left join fi_names n on n.mint = p.mint where n.mint is null order by (p.config in (${ours})) desc, p.day_income desc, p.creator_life desc limit ?`).all(...this.opts.ourConfigs, this.opts.namesPerPass);
    const mints = rows.map((r: any) => String(r.mint));
    const put = this.db.db.prepare("insert into fi_names (mint, name, symbol, checked_at) values (?, ?, ?, ?) on conflict (mint) do update set name = excluded.name, symbol = excluded.symbol, checked_at = excluded.checked_at");
    for (let i = 0; i < mints.length; i += 100) {
      const chunk = mints.slice(i, i + 100);
      const pdas = chunk.map((m: string) => PublicKey.findProgramAddressSync([Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), new PublicKey(m).toBuffer()], METADATA_PROGRAM)[0]);
      const infos = await this.conn.getMultipleAccountsInfo(pdas, "confirmed");
      chunk.forEach((m: string, j: number) => { const md = infos[j] ? parseMetaplexMetadata(infos[j]!.data) : null; put.run(m, md?.name?.trim() || null, md?.symbol?.trim() || null, Date.now()); });
    }
  }

  // ---- reads for the API ----
  status() {
    const n = this.db.db.prepare("select count(*) as pools, count(distinct config) as configs from fi_pools").get();
    return { mode: "all-dbc", pools: Number(n.pools), configs: Number(n.configs), fullSlot: Number(this.db.meta("full_slot") ?? 0), deltaSlot: Number(this.db.meta("delta_slot") ?? 0), fullAtMs: Number(this.db.meta("full_at") ?? 0), deltaAtMs: Number(this.db.meta("delta_at") ?? 0), fullEveryHours: this.opts.fullEveryHours, deltaEveryMinutes: this.opts.deltaEveryMinutes };
  }

  private coinView(r: any, nowMs: number, slot: number) {
    const cfg = this.configs.get(r.config);
    const reasons: string[] = [...(cfg?.reasons ?? [])];
    const progress = Number(r.progress);
    if (progress === 1 || progress === 2) reasons.push("waiting for migration");
    const activation = BigInt(r.activation);
    const launchedAtMs = cfg?.activationType === 1 ? Number(activation) * 1000 : nowMs - Math.max(0, slot - Number(activation)) * 400;
    const days = Math.max(1, (nowMs - launchedAtMs) / 86_400_000);
    const life = BigInt(r.creator_life);
    return {
      mint: r.mint, pool: r.pool, config: r.config, creator: r.creator, launchpad: cfg?.feeClaimer ?? null, ours: this.opts.ourConfigs.includes(r.config),
      name: r.name ?? null, symbol: r.symbol ?? null, stage: stageOf(progress), creatorFeePct: cfg?.creatorPct ?? null,
      creatorLifetimeLamports: life.toString(), creatorLast24hLamports: String(r.day_income), last24hWindowHours: Number(r.day_hours), creatorAvgPerDayLamports: (life / BigInt(Math.round(days * 1000)) * 1000n).toString(),
      claimableLamports: String(r.creator_fee), launchedAtMs: Math.round(launchedAtMs), tailEligible: reasons.length === 0, reasons, changedAtMs: Number(r.changed_at),
    };
  }

  coins(q: { sort: "day" | "claimable" | "lifetime" | "avg"; stage: string; eligible: boolean; creator: string | null; search: string | null; limit: number; offset: number }, slot: number) {
    const where: string[] = [], args: any[] = [];
    if (q.stage === "bonding") where.push("p.progress = 0"); else if (q.stage === "graduated") where.push("p.progress = 3");
    if (q.eligible) { where.push("c.reasons = '[]'"); where.push("p.progress in (0, 3)"); }
    if (q.creator) { where.push("p.creator = ?"); args.push(q.creator); }
    if (q.search) { where.push("(p.mint = ? or p.pool = ? or lower(n.name) like ? or lower(n.symbol) like ?)"); const s = q.search.toLowerCase(); args.push(q.search, q.search, `%${s}%`, `%${s}%`); }
    const order = q.sort === "claimable" ? "p.creator_fee desc" : q.sort === "lifetime" ? "p.creator_life desc" : "p.day_income desc, p.creator_life desc";
    const sql = `select p.*, n.name, n.symbol from fi_pools p join fi_configs c on c.config = p.config left join fi_names n on n.mint = p.mint ${where.length ? "where " + where.join(" and ") : ""} order by ${order} limit ? offset ?`;
    const rows = this.db.db.prepare(sql).all(...args, q.limit, q.offset);
    const now = Date.now();
    let out = rows.map((r: any) => this.coinView(r, now, slot));
    if (q.sort === "avg") out = out.sort((a: any, b: any) => (BigInt(b.creatorAvgPerDayLamports) > BigInt(a.creatorAvgPerDayLamports) ? 1 : -1));
    return out;
  }

  coin(mint: string, slot: number) {
    const r = this.db.db.prepare("select p.*, n.name, n.symbol from fi_pools p left join fi_names n on n.mint = p.mint where p.mint = ?").get(mint);
    return r ? this.coinView(r, Date.now(), slot) : null;
  }

  /** Launchpads (fee claimers) ranked by what their creators earn, ours flagged; precomputed after each walk. */
  summarize() {
    const rows = this.db.db.prepare(`select c.fee_claimer as launchpad, count(*) as coins, sum(case when p.progress = 3 then 1 else 0 end) as graduated, sum(case when c.reasons = '[]' and p.progress in (0, 3) then 1 else 0 end) as eligible,
      sum(p.creator_life) as lifetime, sum(p.day_income) as day, sum(p.creator_fee) as claimable, count(distinct p.config) as configs, max(c.creator_pct) as creator_pct_max, min(c.creator_pct) as creator_pct_min
      from fi_pools p join fi_configs c on c.config = p.config group by c.fee_claimer order by day desc, lifetime desc limit 200`).all();
    const ourClaimers = new Set(this.opts.ourConfigs.map((k) => this.configs.get(k)?.feeClaimer).filter(Boolean) as string[]);
    // the protocol's own launchpads always appear, ranked where they stand, even below the top 200
    const listed = new Set(rows.map((r: any) => String(r.launchpad)));
    const missing = [...ourClaimers].filter((k) => !listed.has(k));
    if (missing.length) {
      const extra = this.db.db.prepare(`select c.fee_claimer as launchpad, count(*) as coins, sum(case when p.progress = 3 then 1 else 0 end) as graduated, sum(case when c.reasons = '[]' and p.progress in (0, 3) then 1 else 0 end) as eligible,
        sum(p.creator_life) as lifetime, sum(p.day_income) as day, sum(p.creator_fee) as claimable, count(distinct p.config) as configs, max(c.creator_pct) as creator_pct_max, min(c.creator_pct) as creator_pct_min
        from fi_pools p join fi_configs c on c.config = p.config where c.fee_claimer in (${missing.map(() => "?").join(",")}) group by c.fee_claimer`).all(...missing);
      const rank = this.db.db.prepare(`select count(*) + 1 as rank from (select sum(p.day_income) as d, sum(p.creator_life) as l from fi_pools p join fi_configs c on c.config = p.config group by c.fee_claimer) where d > ? or (d = ? and l > ?)`);
      for (const e of extra) { e.rank = Number(rank.get(e.day, e.day, e.lifetime).rank); rows.push(e); }
    }
    const ourConfigs = this.opts.ourConfigs.map((k) => {
      const c = this.configs.get(k);
      const s = this.db.db.prepare("select count(*) as coins, sum(creator_life) as lifetime, sum(day_income) as day, sum(creator_fee) as claimable, sum(case when progress = 3 then 1 else 0 end) as graduated from fi_pools where config = ?").get(k);
      return { config: k, launchpad: c?.feeClaimer ?? null, creatorFeePct: c?.creatorPct ?? null, tailEligibleConfig: c ? c.reasons.length === 0 : null, coins: Number(s?.coins ?? 0), graduated: Number(s?.graduated ?? 0), creatorLifetimeLamports: String(s?.lifetime ?? 0), creatorLast24hLamports: String(s?.day ?? 0), claimableLamports: String(s?.claimable ?? 0) };
    });
    return {
      generatedAtMs: Date.now(),
      launchpads: rows.map((r: any, i: number) => ({ rank: r.rank ?? i + 1, launchpad: r.launchpad, ours: ourClaimers.has(r.launchpad), coins: Number(r.coins), configs: Number(r.configs), graduated: Number(r.graduated), tailEligibleCoins: Number(r.eligible), creatorLifetimeLamports: String(r.lifetime), creatorLast24hLamports: String(r.day), claimableLamports: String(r.claimable), creatorFeePct: Number(r.creator_pct_min) === Number(r.creator_pct_max) ? Number(r.creator_pct_max) : null })),
      ourConfigs,
    };
  }
}

/** DBC events emitted through the event-authority self-CPI in a transaction, with their ordinal. */
export function dbcEvents(chain: Chain, tx: any): { name: string; data: any; ordinal: number }[] {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
  const out: { name: string; data: any; ordinal: number }[] = [];
  let ordinal = 0;
  for (const ii of tx.meta?.innerInstructions ?? []) {
    for (const x of ii.instructions) {
      const pid = keys.get(x.programIdIndex);
      const data = Buffer.from(utils.bytes.bs58.decode(x.data));
      if (!pid || !pid.equals(DBC_PROGRAM_ID) || data.length < 16 || !data.subarray(0, 8).equals(EVENT_IX)) continue;
      ordinal++;
      try { const ev: any = chain.dbc.coder.events.decode(data.subarray(8).toString("base64")); if (ev) out.push({ name: ev.name, data: ev.data, ordinal }); } catch { /* not an event this IDL knows */ }
    }
  }
  return out;
}
