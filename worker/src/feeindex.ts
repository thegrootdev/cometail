// The Fee Index: every SOL-paired Meteora DBC coin, from any launchpad, with what its creator earns.
//
// Coverage without hammering the RPC. The DBC program holds about 1.75 million pools and half a
// million configs, so nothing here scans the program with plain getProgramAccounts (the provider
// refuses it). Instead:
//   - a FULL walk, at start and then daily: every SOL-quoted config (one paginated, sliced
//     getProgramAccountsV2 walk filtered on the quote mint, about one minute), then every pool (the
//     same, 296 bytes per pool from the config address through the creator fee, about four minutes);
//   - a DELTA walk every few minutes: the same pool walk with changedSinceSlot, which returns only
//     pools written since the last walk (fifteen minutes is about a hundred pools, ten seconds).
// Configs are immutable once created, so each is read once; a pool on a config the cache has not
// seen yet brings that config in through a sliced getMultipleAccounts.
//
// What is kept: pools on SOL-quoted configs that ever paid their creator. What is derived, and how
// exact it is:
//   - lifetime creator fees: an ESTIMATE, the pool's lifetime trading-fee counter times the config's
//     creator percentage (the program floors the creator share swap by swap, so the true sum can be a
//     few lamports per swap lower); the average per day since activation inherits that;
//   - the last 24 hours: an ESTIMATE from hourly snapshots holding the counter's last observed value
//     in each hour, so the base is the counter at the end of the hour 24 hours back; a pool younger
//     in the index than that reports its shorter window;
//   - the creator fee claimable now: exact (the pool's own field);
//   - whether the config lets the creator rights launch a tail: the config part of the program's
//     deposit rules (eligibility.rs check_dbc_rights) and a stage the vault accepts; the deposit itself
//     checks the coin's mint.
// Post-graduation fees on the creator's locked DAMM v2 position are not in the DBC pool and not here.
//
// Claims. Between two walks a pool's claimable creator (or partner) fee should grow by its share of
// the counter's growth; when it grew by less than that, beyond a rounding tolerance, a claim happened
// (a plain fall is the simple case; a claim masked by new trading is caught the same way). The pool's
// transactions inside the walk window (from the previous walk's slot to the slot read after this walk
// ended) are read for the claim events, published on the public feed as `claim` rows with their exact
// amounts. A lookup that cannot finish (a transaction not available yet) stays pending and is retried;
// one that reads the whole window without finding the event, or a pool busier than the lookup cap,
// is recorded as unconfirmed, never published, never silently dropped.
//
// u64 storage: lamport amounts of SOL-quoted pools are bounded by the SOL supply (below 2^63) and are
// kept as SQLite integers; the config threshold, an unbounded u64, is kept as text.
import { Connection, PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { createHash } from "crypto";
import { Chain, DBC_PROGRAM_ID } from "./chain";
import { readTx } from "./indexer";
import { publish } from "./feed";
import type { Store, FeedRow } from "./store";
import { parseMetaplexMetadata } from "./tokens";
import { log } from "./tx";
import { ESTIMATE_BASIS } from "./fee-basis";

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

const HOUR = 3_600_000, DAY = 86_400_000;
/** Below this shortfall, a claimable fee that grew less than its share of the counter is rounding, not a claim.
 *  Without trading in between (expected 0) there is no rounding, so any fall is a claim. */
export const claimTolerance = (expected: bigint) => (expected === 0n ? 0n : 1_000n + expected / 200n);
/** Up to this many signatures of one pool are read to find the claims of one walk window. */
const CLAIM_SIGNATURE_CAP = 300;
const CLAIM_ATTEMPTS = 6;

/** The index's own SQLite file, apart from the main store (its schema rebuilds never touch it). */
class IndexDb {
  db: any;
  constructor(private file: string) {}
  async open() {
    const { DatabaseSync } = await import("node:sqlite");
    this.db = new DatabaseSync(this.file);
    // every statement reads integers as BigInt; every reader converts with BigInt(), Number() or String()
    const prepare = this.db.prepare.bind(this.db);
    this.db.prepare = (sql: string) => { const st = prepare(sql); st.setReadBigInts(true); return st; };
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists fi_meta (key text primary key, value text not null);
      create table if not exists fi_configs (config text primary key, fee_claimer text not null, creator_pct integer not null, activation_type integer not null, partner_locked integer not null, creator_locked integer not null, threshold text not null, reasons text not null);
      create index if not exists fi_configs_claimer on fi_configs (fee_claimer);
      create table if not exists fi_pools (pool text primary key, config text not null, creator text not null, mint text not null, progress integer not null, ttq integer not null, creator_fee integer not null, partner_fee integer not null, quote_reserve integer not null, activation integer not null, launched_at integer not null, finish_ts integer not null, creator_life integer not null, day_income integer not null default 0, day_hours real not null default 0, changed_at integer not null, updated_at integer not null);
      create index if not exists fi_pools_creator on fi_pools (creator);
      create index if not exists fi_pools_mint on fi_pools (mint);
      create index if not exists fi_pools_config on fi_pools (config);
      create index if not exists fi_pools_life on fi_pools (creator_life desc);
      create index if not exists fi_pools_day on fi_pools (day_income desc);
      create index if not exists fi_pools_claimable on fi_pools (creator_fee desc);
      create table if not exists fi_hours (pool text not null, hour integer not null, ttq integer not null, primary key (pool, hour));
      create table if not exists fi_names (mint text primary key, name text, symbol text, checked_at integer not null);
      create table if not exists fi_claims (id integer primary key autoincrement, pool text not null, role text not null, from_slot integer not null, to_slot integer, shortfall integer not null, attempts integer not null default 0, status text not null default 'pending', note text);
      create index if not exists fi_claims_status on fi_claims (status);
    `);
  }
  meta(key: string): string | null { const r = this.db.prepare("select value from fi_meta where key = ?").get(key); return r ? String(r.value) : null; }
  setMeta(key: string, value: string) { this.db.prepare("insert into fi_meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(key, value); }
  close() { this.db?.close(); }
}

export { ESTIMATE_BASIS } from "./fee-basis";

/** The file behind COMETAIL_FEE_INDEX_DB: `sqlite:/path/file.sqlite`, the form DATABASE_URL uses, or a plain path. */
export function feeIndexPath(value: string): string {
  const v = value.trim();
  if (v.startsWith("sqlite:")) return v.slice("sqlite:".length);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) throw new Error(`COMETAIL_FEE_INDEX_DB must be sqlite:/path or a file path (got ${v.split(":")[0]}:)`);
  return v;
}

/** Opens the index, or returns null and logs why: one feature never takes the indexer and its API down. */
export async function openFeeIndexSoft(chain: Chain, store: Store, value: string, opts: FeeIndexOptions, report: (msg: string, extra: Record<string, unknown>) => void = log): Promise<FeeIndex | null> {
  try {
    const fi = new FeeIndex(chain, store, feeIndexPath(value), opts);
    await fi.open();
    return fi;
  } catch (e) {
    report("fee index disabled: its database could not be opened; the indexer and the API run without it", { value, error: String((e as Error).message ?? e) });
    return null;
  }
}

export class FeeIndex {
  readonly db: IndexDb;
  private configs = new Map<string, IndexConfig | null>();
  private running = false;
  /** Injected for tests: the chain's current slot. */
  slotNow: () => Promise<number>;
  constructor(private chain: Chain, private store: Store, file: string, private opts: FeeIndexOptions) {
    this.db = new IndexDb(file);
    this.slotNow = () => this.conn.getSlot("confirmed");
  }
  private get conn(): Connection { return this.chain.connection; }

  async open() { await this.db.open(); for (const r of this.db.db.prepare("select * from fi_configs").all()) this.configs.set(String(r.config), this.configRow(r)); }
  close() { this.db.close(); }
  private configRow(r: any): IndexConfig { return { config: String(r.config), quoteMint: WSOL, feeClaimer: String(r.fee_claimer), creatorPct: Number(r.creator_pct), activationType: Number(r.activation_type), partnerLocked: Number(r.partner_locked), creatorLocked: Number(r.creator_locked), threshold: BigInt(String(r.threshold)), reasons: JSON.parse(String(r.reasons)) }; }
  /** For tests: a config the index knows. */
  rememberConfig(c: IndexConfig) { this.configs.set(c.config, c); this.saveConfig(c); }

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

  /** Upserts the kept pools of a page and records claim candidates (open-ended: their window closes when the walk ends). */
  applyPools(pools: IndexPool[], slot: number, nowMs: number, fromSlot: number): { kept: number; claims: { pool: string; role: "creator" | "partner"; shortfall: bigint }[] } {
    const claims: { pool: string; role: "creator" | "partner"; shortfall: bigint }[] = [];
    const get = this.db.db.prepare("select ttq, creator_fee, partner_fee from fi_pools where pool = ?");
    const put = this.db.db.prepare(`insert into fi_pools (pool, config, creator, mint, progress, ttq, creator_fee, partner_fee, quote_reserve, activation, launched_at, finish_ts, creator_life, changed_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict (pool) do update set creator = excluded.creator, progress = excluded.progress, ttq = excluded.ttq, creator_fee = excluded.creator_fee, partner_fee = excluded.partner_fee, quote_reserve = excluded.quote_reserve, finish_ts = excluded.finish_ts, creator_life = excluded.creator_life,
        changed_at = case when fi_pools.ttq <> excluded.ttq or fi_pools.creator_fee <> excluded.creator_fee or fi_pools.partner_fee <> excluded.partner_fee or fi_pools.progress <> excluded.progress then excluded.changed_at else fi_pools.changed_at end, updated_at = excluded.updated_at`);
    // the counter's LAST observed value in each hour: the base of a 24-hour window is the counter at the end of an hour
    const hour = this.db.db.prepare("insert into fi_hours (pool, hour, ttq) values (?, ?, ?) on conflict (pool, hour) do update set ttq = excluded.ttq");
    const claim = this.db.db.prepare("insert into fi_claims (pool, role, from_slot, to_slot, shortfall) values (?, ?, ?, null, ?)");
    const h = Math.floor(nowMs / HOUR);
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
          const grew = p.ttq - BigInt(prev.ttq);
          const creatorExpected = grew > 0n ? creatorShare(grew, cfg.creatorPct) : 0n;
          const partnerExpected = grew > 0n ? grew - creatorExpected : 0n;
          const creatorShort = BigInt(prev.creator_fee) + creatorExpected - p.creatorFee;
          const partnerShort = BigInt(prev.partner_fee) + partnerExpected - p.partnerFee;
          if (creatorShort > claimTolerance(creatorExpected)) claims.push({ pool: p.pool, role: "creator", shortfall: creatorShort });
          if (partnerShort > claimTolerance(partnerExpected)) claims.push({ pool: p.pool, role: "partner", shortfall: partnerShort });
        }
        // activation is a timestamp or a slot (by the config); a slot becomes a time at 400 ms per slot from the walk's slot
        const launchedAt = cfg.activationType === 1 ? Number(p.activation) * 1000 : nowMs - Math.max(0, slot - Number(p.activation)) * 400;
        put.run(p.pool, p.config, p.creator, p.mint, p.progress, p.ttq.toString(), p.creatorFee.toString(), p.partnerFee.toString(), p.quoteReserve.toString(), p.activation.toString(), Math.round(launchedAt), p.finishTs, life.toString(), nowMs, nowMs);
        hour.run(p.pool, h, p.ttq.toString());
        kept++;
      }
      for (const c of claims) claim.run(c.pool, c.role, fromSlot, c.shortfall.toString());
      this.db.db.exec("commit");
    } catch (e) { this.db.db.exec("rollback"); throw e; }
    return { kept, claims };
  }

  /** Closes the window of the claims recorded during a walk at the slot read after it ended. */
  closeClaimWindows(endSlot: number) { this.db.db.prepare("update fi_claims set to_slot = ? where to_slot is null").run(endSlot); }

  /** The last 24 hours per pool. Snapshots hold each hour's last observed value; a pool absent from every
   *  walk between two snapshots did not change, so the latest snapshot at or before the hour 24 hours back
   *  is the counter at the end of that hour. Pools quiet for more than 25 hours earned nothing. */
  refreshDayIncome(nowMs: number) {
    const h = Math.floor(nowMs / HOUR), cut = h - 24;
    this.db.db.exec("begin");
    try {
      const rows = this.db.db.prepare("select p.pool, p.ttq, c.creator_pct from fi_pools p join fi_configs c on c.config = p.config where p.changed_at >= ?").all(nowMs - 25 * HOUR);
      const base = this.db.db.prepare("select hour, ttq from fi_hours where pool = ? and hour <= ? order by hour desc limit 1");
      const oldest = this.db.db.prepare("select hour, ttq from fi_hours where pool = ? order by hour asc limit 1");
      const set = this.db.db.prepare("update fi_pools set day_income = ?, day_hours = ? where pool = ?");
      for (const r of rows) {
        const full = base.get(r.pool, cut);
        const b = full ?? oldest.get(r.pool);
        if (!b) continue;
        const delta = BigInt(r.ttq) - BigInt(b.ttq);
        const hours = full ? 24 : Math.max(0, h - Number(b.hour));
        set.run((delta > 0n ? creatorShare(delta, Number(r.creator_pct)) : 0n).toString(), hours, r.pool);
      }
      this.db.db.prepare("update fi_pools set day_income = 0, day_hours = 24 where changed_at < ? and (day_income <> 0 or day_hours <> 24)").run(nowMs - 25 * HOUR);
      // the daily full walk writes every kept pool, so a base is never older than a day plus a walk
      this.db.db.prepare("delete from fi_hours where hour < ?").run(h - 50);
      this.db.db.exec("commit");
    } catch (e) { this.db.db.exec("rollback"); throw e; }
  }

  /** When the index's history began, and whether a full day of it exists yet. */
  history(nowMs = Date.now()) {
    const first = Number(this.db.meta("first_full_at") ?? 0);
    return { historySinceMs: first, fullDay: first > 0 && nowMs - first >= DAY };
  }

  /** A full walk: every SOL config, then every pool. */
  async full(): Promise<void> {
    const t0 = Date.now();
    const slot = await this.slotNow();
    let configs = 0;
    this.db.db.exec("begin");
    try {
      for await (const page of this.walk([{ memcmp: { offset: 0, bytes: CONFIG_DISC } }, { memcmp: { offset: CONFIG.quoteMint, bytes: WSOL } }], CONFIG_SLICE)) {
        for (const a of page) { const c = decodeConfigSlice(a.pubkey, a.data); this.configs.set(a.pubkey, c); this.saveConfig(c); configs++; }
      }
      this.db.db.exec("commit");
    } catch (e) { this.db.db.exec("rollback"); throw e; }
    const fromSlot = Math.max(0, Number(this.db.meta("delta_slot") ?? slot) - 150);
    let pools = 0, kept = 0;
    for await (const page of this.walk([{ memcmp: { offset: 0, bytes: POOL_DISC } }], POOL_SLICE)) {
      const decoded = page.map((a) => decodePoolSlice(a.pubkey, a.data));
      await this.loadConfigs(decoded.map((p) => p.config));
      kept += this.applyPools(decoded, slot, Date.now(), fromSlot).kept; pools += decoded.length;
    }
    this.closeClaimWindows(await this.slotNow());
    this.db.setMeta("full_slot", String(slot)); this.db.setMeta("delta_slot", String(slot)); this.db.setMeta("full_at", String(Date.now()));
    if (!this.db.meta("first_full_at")) this.db.setMeta("first_full_at", String(t0));
    this.refreshDayIncome(Date.now());
    log("fee index full walk", { configs, pools, kept, seconds: Math.round((Date.now() - t0) / 1000) });
  }

  /** A delta walk: only the pools written since the last walk (with an overlap of 150 slots). */
  async delta(): Promise<void> {
    const t0 = Date.now();
    const since = Number(this.db.meta("delta_slot") ?? "0");
    const slot = await this.slotNow();
    let changed = 0, kept = 0, claims = 0;
    for await (const page of this.walk([{ memcmp: { offset: 0, bytes: POOL_DISC } }], POOL_SLICE, Math.max(0, since - 150))) {
      if (!page.length) continue;
      const decoded = page.map((a) => decodePoolSlice(a.pubkey, a.data));
      await this.loadConfigs(decoded.map((p) => p.config));
      const r = this.applyPools(decoded, slot, Date.now(), Math.max(0, since - 150)); changed += decoded.length; kept += r.kept; claims += r.claims.length;
    }
    this.closeClaimWindows(await this.slotNow());
    this.db.setMeta("delta_slot", String(slot)); this.db.setMeta("delta_at", String(Date.now()));
    this.refreshDayIncome(Date.now());
    log("fee index delta", { changed, kept, claims, seconds: Math.round((Date.now() - t0) / 1000) });
  }

  /** The run loop: a full walk when none is recent, deltas between; then claims, names and the summary. Never overlaps itself. */
  async pass(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const fullAt = Number(this.db.meta("full_at") ?? "0");
      if (Date.now() - fullAt > this.opts.fullEveryHours * HOUR) await this.full(); else await this.delta();
      await this.resolveClaims();
      await this.fillNames();
      this.db.setMeta("summary", JSON.stringify(this.summarize()));
    } finally { this.running = false; }
  }

  /** Signatures of a pool inside [fromSlot, toSlot], newest first, up to the cap; `complete` says whether the window was reached. */
  async windowSignatures(pool: string, fromSlot: number, toSlot: number): Promise<{ sigs: { signature: string; slot: number; err: unknown }[]; complete: boolean }> {
    const out: { signature: string; slot: number; err: unknown }[] = [];
    let before: string | undefined;
    for (let read = 0; read < CLAIM_SIGNATURE_CAP; ) {
      const page = await this.conn.getSignaturesForAddress(new PublicKey(pool), { limit: 100, before }, "confirmed");
      read += page.length;
      for (const s of page) { if (s.slot < fromSlot) return { sigs: out, complete: true }; if (s.slot <= toSlot) out.push({ signature: s.signature, slot: s.slot, err: s.err }); }
      if (page.length < 100) return { sigs: out, complete: true };
      before = page[page.length - 1].signature;
    }
    return { sigs: out, complete: false };
  }

  /** Exact claim amounts from the claim events in each candidate's window, published as `claim` feed rows. */
  async resolveClaims(): Promise<void> {
    const pending = this.db.db.prepare("select id, pool, role, from_slot, to_slot, attempts from fi_claims where status = 'pending' and to_slot is not null order by id asc limit ?").all(this.opts.claimLookupsPerPass);
    const setStatus = this.db.db.prepare("update fi_claims set status = ?, attempts = ?, note = ? where id = ?");
    for (const c of pending) {
      const id = c.id, pool = String(c.pool), role = String(c.role), attempts = Number(c.attempts) + 1;
      try {
        const { sigs, complete } = await this.windowSignatures(pool, Number(c.from_slot), Number(c.to_slot));
        const mintRow = this.db.db.prepare("select mint from fi_pools where pool = ?").get(pool);
        const feed: FeedRow[] = [];
        let unread = 0;
        for (const s of sigs) {
          if (s.err) continue;
          const tx = await readTx(this.conn, s.signature);
          if (!tx) { unread++; continue; }
          for (const ev of dbcEvents(this.chain, tx)) {
            if (ev.name !== "evtClaimCreatorTradingFee" && ev.name !== "evtClaimTradingFee") continue;
            if (String(ev.data.pool) !== pool) continue;
            const evRole = ev.name === "evtClaimCreatorTradingFee" ? "creator" : "partner";
            feed.push({ slot: s.slot, ordinal: ev.ordinal, signature: s.signature, type: "claim", vault: null, mint: mintRow ? String(mintRow.mint) : null, provenance: { source: "chain", signature: s.signature, slot: s.slot }, at: Date.now(),
              data: { mint: mintRow ? String(mintRow.mint) : null, pool, role: evRole, quoteAmountLamports: String(ev.data.tokenQuoteAmount ?? "0"), baseAmountRaw: String(ev.data.tokenBaseAmount ?? "0"), signature: s.signature } });
          }
        }
        // what was read is published now (a row's identity is its signature and ordinal, so a retry never
        // repeats one); the candidate finishes only when its whole window was read
        if (feed.length) await publish(this.store, feed);
        const found = feed.some((f) => f.data.role === role);
        if (unread > 0 && attempts < CLAIM_ATTEMPTS) setStatus.run("pending", attempts, `${unread} transactions not available yet${found ? "; some claims published" : ""}`, id);
        else if (!complete) setStatus.run(found ? "partial" : "unconfirmed", attempts, `more than ${CLAIM_SIGNATURE_CAP} signatures in the window`, id);
        else if (unread > 0) setStatus.run(found ? "partial" : "unconfirmed", attempts, `${unread} transactions never became available`, id);
        else setStatus.run(found ? "confirmed" : "unconfirmed", attempts, found ? null : "no claim event in the window", id);
      } catch (e) {
        setStatus.run(attempts < CLAIM_ATTEMPTS ? "pending" : "unconfirmed", attempts, String((e as Error).message ?? e).slice(0, 200), id);
      }
    }
  }

  /** Names for the coins people look at first: ours, then the top earners without a name yet, Metaplex metadata read 100 at a time. */
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
    const claims = this.db.db.prepare("select status, count(*) as n from fi_claims group by status").all();
    const h = this.history();
    return { mode: "all-dbc", pools: Number(n.pools), configs: Number(n.configs), fullSlot: Number(this.db.meta("full_slot") ?? 0), deltaSlot: Number(this.db.meta("delta_slot") ?? 0), fullAtMs: Number(this.db.meta("full_at") ?? 0), deltaAtMs: Number(this.db.meta("delta_at") ?? 0), fullEveryHours: this.opts.fullEveryHours, deltaEveryMinutes: this.opts.deltaEveryMinutes,
      historySinceMs: h.historySinceMs, fullDayOfHistory: h.fullDay, claims: Object.fromEntries(claims.map((r: any) => [String(r.status), Number(r.n)])) };
  }

  private coinView(r: any, nowMs: number) {
    const cfg = this.configs.get(String(r.config));
    const reasons: string[] = [...(cfg?.reasons ?? [])];
    const progress = Number(r.progress);
    if (progress === 1 || progress === 2) reasons.push("waiting for migration");
    const launchedAtMs = Number(r.launched_at);
    const life = BigInt(r.creator_life);
    const span = BigInt(Math.max(DAY, nowMs - launchedAtMs));
    return {
      mint: String(r.mint), pool: String(r.pool), config: String(r.config), creator: String(r.creator), launchpad: cfg?.feeClaimer ?? null, ours: this.opts.ourConfigs.includes(String(r.config)),
      name: r.name ?? null, symbol: r.symbol ?? null, stage: stageOf(progress), creatorFeePct: cfg?.creatorPct ?? null,
      creatorLifetimeEstimateLamports: life.toString(), creatorLast24hEstimateLamports: String(r.day_income), last24hWindowHours: Number(r.day_hours),
      creatorAvgPerDayEstimateLamports: ((life * BigInt(DAY)) / span).toString(),
      claimableLamports: String(r.creator_fee), launchedAtMs, configAllowsTail: reasons.length === 0, reasons, changedAtMs: Number(r.changed_at),
    };
  }

  coins(q: { sort: "day" | "claimable" | "lifetime" | "avg"; stage: string; eligible: boolean; creator: string | null; search: string | null; limit: number; offset: number }, nowMs = Date.now()) {
    const where: string[] = [], args: any[] = [];
    if (q.stage === "bonding") where.push("p.progress = 0"); else if (q.stage === "graduated") where.push("p.progress = 3");
    if (q.eligible) { where.push("c.reasons = '[]'"); where.push("p.progress in (0, 3)"); }
    if (q.creator) { where.push("p.creator = ?"); args.push(q.creator); }
    if (q.search) { where.push("(p.mint = ? or p.pool = ? or lower(n.name) like ? or lower(n.symbol) like ?)"); const s = q.search.toLowerCase(); args.push(q.search, q.search, `%${s}%`, `%${s}%`); }
    // every order is global (before LIMIT/OFFSET) with the pool as the stable tiebreaker
    const order = q.sort === "claimable" ? "p.creator_fee desc, p.pool"
      : q.sort === "lifetime" ? "p.creator_life desc, p.pool"
      : q.sort === "avg" ? `(p.creator_life * ${DAY}.0) / max(${DAY}, ? - p.launched_at) desc, p.pool`
      : "p.day_income desc, p.creator_life desc, p.pool";
    const orderArgs = q.sort === "avg" ? [nowMs] : [];
    const sql = `select p.*, n.name, n.symbol from fi_pools p join fi_configs c on c.config = p.config left join fi_names n on n.mint = p.mint ${where.length ? "where " + where.join(" and ") : ""} order by ${order} limit ? offset ?`;
    return this.db.db.prepare(sql).all(...args, ...orderArgs, q.limit, q.offset).map((r: any) => this.coinView(r, nowMs));
  }

  coin(mint: string) {
    const r = this.db.db.prepare("select p.*, n.name, n.symbol from fi_pools p left join fi_names n on n.mint = p.mint where p.mint = ?").get(mint);
    return r ? this.coinView(r, Date.now()) : null;
  }

  /** Names and pools by mint or pool, for other readers (the Tails rollup). */
  lookup(key: string): { mint: string; pool: string; name: string | null; symbol: string | null } | null {
    const r = this.db.db.prepare("select p.mint, p.pool, n.name, n.symbol from fi_pools p left join fi_names n on n.mint = p.mint where p.pool = ? or p.mint = ? limit 1").get(key, key);
    return r ? { mint: String(r.mint), pool: String(r.pool), name: r.name ?? null, symbol: r.symbol ?? null } : null;
  }

  /** Launchpads (fee claimers) ranked by what their creators earn, ours flagged; precomputed after each walk.
   *  Until the index holds a full day of history the 24-hour figures are not comparable, so the ranking is by lifetime. */
  summarize(nowMs = Date.now()) {
    const { fullDay, historySinceMs } = this.history(nowMs);
    const rankedBy = fullDay ? "last24h" : "lifetime";
    const orderBy = fullDay ? "day desc, lifetime desc, launchpad" : "lifetime desc, launchpad";
    const agg = `select c.fee_claimer as launchpad, count(*) as coins, sum(case when p.progress = 3 then 1 else 0 end) as graduated, sum(case when c.reasons = '[]' and p.progress in (0, 3) then 1 else 0 end) as eligible,
      sum(p.creator_life) as lifetime, sum(p.day_income) as day, sum(p.creator_fee) as claimable, count(distinct p.config) as configs, max(c.creator_pct) as creator_pct_max, min(c.creator_pct) as creator_pct_min,
      sum(case when p.day_hours < 24 then 1 else 0 end) as partial
      from fi_pools p join fi_configs c on c.config = p.config`;
    const rows: any[] = this.db.db.prepare(`${agg} group by c.fee_claimer order by ${orderBy} limit 200`).all();
    rows.forEach((r, i) => { r.rank = i + 1; });
    const ourClaimers = new Set(this.opts.ourConfigs.map((k) => this.configs.get(k)?.feeClaimer).filter(Boolean) as string[]);
    const listed = new Set(rows.map((r) => String(r.launchpad)));
    const missing = [...ourClaimers].filter((k) => !listed.has(k));
    if (missing.length) {
      const extra: any[] = this.db.db.prepare(`${agg} where c.fee_claimer in (${missing.map(() => "?").join(",")}) group by c.fee_claimer`).all(...missing);
      const rank = this.db.db.prepare(fullDay
        ? `select count(*) + 1 as rank from (select c.fee_claimer as k, sum(p.day_income) as d, sum(p.creator_life) as l from fi_pools p join fi_configs c on c.config = p.config group by c.fee_claimer) where d > ? or (d = ? and (l > ? or (l = ? and k < ?)))`
        : `select count(*) + 1 as rank from (select c.fee_claimer as k, sum(p.creator_life) as l from fi_pools p join fi_configs c on c.config = p.config group by c.fee_claimer) where l > ? or (l = ? and k < ?)`);
      for (const e of extra) { e.rank = Number((fullDay ? rank.get(e.day, e.day, e.lifetime, e.lifetime, e.launchpad) : rank.get(e.lifetime, e.lifetime, e.launchpad)).rank); rows.push(e); }
    }
    const ourConfigs = this.opts.ourConfigs.map((k) => {
      const c = this.configs.get(k);
      if (!c) return { config: k, covered: false, note: "not SOL-quoted: outside the Fee Index and outside what the vault accepts" };
      const s = this.db.db.prepare("select count(*) as coins, sum(creator_life) as lifetime, sum(day_income) as day, sum(creator_fee) as claimable, sum(case when progress = 3 then 1 else 0 end) as graduated from fi_pools where config = ?").get(k);
      return { config: k, covered: true, launchpad: c.feeClaimer, creatorFeePct: c.creatorPct, tailEligibleConfig: c.reasons.length === 0, coins: Number(s?.coins ?? 0), graduated: Number(s?.graduated ?? 0), creatorLifetimeEstimateLamports: String(s?.lifetime ?? 0), creatorLast24hEstimateLamports: String(s?.day ?? 0), claimableLamports: String(s?.claimable ?? 0) };
    });
    return {
      generatedAtMs: nowMs, rankedBy, historySinceMs, basis: ESTIMATE_BASIS,
      launchpads: rows.map((r: any) => ({ rank: Number(r.rank), launchpad: String(r.launchpad), ours: ourClaimers.has(String(r.launchpad)), coins: Number(r.coins), configs: Number(r.configs), graduated: Number(r.graduated), tailEligibleCoins: Number(r.eligible),
        creatorLifetimeEstimateLamports: String(r.lifetime ?? 0), creatorLast24hEstimateLamports: String(r.day ?? 0), coinsWithShorterWindow: Number(r.partial ?? 0), claimableLamports: String(r.claimable ?? 0), creatorFeePct: Number(r.creator_pct_min) === Number(r.creator_pct_max) ? Number(r.creator_pct_max) : null })),
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
